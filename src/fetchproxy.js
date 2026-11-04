// Pine — upstream fetching for Reader mode, downloads and API helpers.
//
// Deliberately built on raw http/https (not fetch) so we control DNS
// resolution at connect time (see ssrf.makeLookup), can stream large
// assets through untouched, and can follow redirects hop-by-hop with
// re-validation of every Location.
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { validateTarget, makeLookup, TargetError } from "./ssrf.js";
import { rewriteHtml, rewriteCss, readerErrorPage } from "./rewrite.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

function upstreamRequest(url, { method, headers, body, lookup, timeout }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method,
        headers,
        lookup,
        timeout,
        maxHeaderSize: 64 * 1024,
        // A readable SNI host is preserved automatically from the URL.
      },
      (res) => resolve(res)
    );
    req.on("timeout", () => req.destroy(new Error(`Timed out connecting to ${url.hostname}`)));
    // Absolute deadline covering DNS + connect (socket timeout alone can
    // leave lookup hangs unbounded on filtered networks).
    const killer = setTimeout(() => req.destroy(new Error(`Timed out connecting to ${url.hostname}`)), timeout + 1500);
    killer.unref?.();
    req.on("response", () => clearTimeout(killer));
    req.on("error", (e) => { clearTimeout(killer); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

// Fetch JSON from a *fixed* API host (suggestions / answers). Not user URLs,
// but run through the same guards anyway.
export async function fetchJson(urlString, cfg, { timeout = 4000 } = {}) {
  const url = validateTarget(urlString, { allowPrivate: cfg.allowPrivate });
  const res = await upstreamRequest(url, {
    method: "GET",
    headers: { "user-agent": UA, accept: "application/json" },
    lookup: makeLookup({ allowPrivate: cfg.allowPrivate }),
    timeout,
  });
  const buf = await readBuffered(res, 2 * 1024 * 1024);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Upstream ${res.statusCode}`);
  return JSON.parse(buf.toString("utf8"));
}

function readBuffered(res, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    res.on("data", (c) => {
      total += c.length;
      if (total > cap) {
        res.destroy();
        reject(new TargetError("That page is too large for Reader mode — try the full browser.", 413));
        return;
      }
      chunks.push(c);
    });
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}

function decompress(buf, encoding) {
  try {
    if (encoding === "gzip") return zlib.gunzipSync(buf);
    if (encoding === "br") return zlib.brotliDecompressSync(buf);
    if (encoding === "deflate") return zlib.inflateSync(buf);
  } catch {
    /* fall through with raw bytes */
  }
  return buf;
}

function decodeBody(buf, contentTypeHeader) {
  let charset = (/charset=([^\s;]+)/i.exec(contentTypeHeader || "") || [])[1];
  if (!charset) {
    const head = buf.subarray(0, 2048).toString("latin1");
    charset = (/<meta[^>]+charset\s*=\s*["']?([^\s"'>;]+)/i.exec(head) || [])[1] || "utf-8";
  }
  charset = charset.toLowerCase().replace(/["']/g, "");
  // Buffer only natively supports utf8/latin1 etc.; windows-125x map closely
  // enough onto latin1 for a reading view.
  if (/utf-?8/.test(charset)) return buf.toString("utf8");
  if (/utf-?16le/.test(charset)) return buf.toString("utf16le");
  return buf.toString("latin1");
}

function requestBody(req, cap = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > cap) {
        reject(new TargetError("Request body too large.", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on("error", reject);
  });
}

// Handles GET/POST /api/fetch?mode=reader|asset&url=...
export async function handleFetch(req, res, cfg) {
  const u = new URL(req.url, "http://pine.internal");
  const mode = u.searchParams.get("mode") === "asset" ? "asset" : "reader";
  const rawTarget = u.searchParams.get("url") || "";

  let target;
  try {
    target = validateTarget(rawTarget, { allowPrivate: cfg.allowPrivate });
    // Refuse to fetch ourselves (prevents silly loops via public hostname).
    if (!cfg.allowPrivate && req.headers.host && target.host === req.headers.host)
      throw new TargetError("Refusing to proxy the proxy.", 403);
  } catch (err) {
    return sendReaderError(res, err, rawTarget);
  }

  const lookup = makeLookup({ allowPrivate: cfg.allowPrivate });
  const body = req.method === "POST" || req.method === "PUT" ? await requestBody(req).catch(() => null) : null;

  let current = target;
  let method = req.method === "POST" ? "POST" : "GET";
  let payload = body;

  try {
    for (let hop = 0; hop <= 8; hop++) {
      const headers = {
        "user-agent": UA,
        accept: mode === "reader"
          ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          : "*/*",
        "accept-language": req.headers["accept-language"] || "en-GB,en;q=0.9",
        "accept-encoding": "gzip, br, deflate",
      };
      if (payload) {
        headers["content-type"] = req.headers["content-type"] || "application/x-www-form-urlencoded";
        headers["content-length"] = String(payload.length);
      }
      if (req.headers["if-none-match"]) headers["if-none-match"] = req.headers["if-none-match"];
      if (req.headers["if-modified-since"]) headers["if-modified-since"] = req.headers["if-modified-since"];

      const up = await upstreamRequest(current, {
        method,
        headers,
        body: payload,
        lookup,
        timeout: cfg.fetchTimeout,
      });

      const status = up.statusCode || 502;
      // Redirects: re-validate each hop ourselves.
      if ([301, 302, 303, 307, 308].includes(status) && up.headers.location) {
        up.resume();
        if (hop === 8) throw new TargetError("Too many redirects.", 502);
        const next = new URL(up.headers.location, current);
        current = validateTarget(next, { allowPrivate: cfg.allowPrivate });
        if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
          method = "GET";
          payload = null;
        }
        continue;
      }

      const type = String(up.headers["content-type"] || "");
      const encoding = String(up.headers["content-encoding"] || "").toLowerCase();
      const isHtml = /text\/html|application\/xhtml/i.test(type);
      const isCss = /text\/css/i.test(type);

      if (mode === "reader" && !isHtml) {
        // Someone followed a "page" link to a file — stream it as a download-ish asset.
        return streamThrough(req, res, up, cfg);
      }
      if ((mode === "reader" && isHtml) || (mode === "asset" && isCss)) {
        const raw = await readBuffered(up, cfg.maxHtml);
        const text = decodeBody(decompress(raw, encoding), type);
        const finalUrl = current.href;
        const out = mode === "reader" ? rewriteHtml(text, finalUrl) : rewriteCss(text, finalUrl);
        const buf = Buffer.from(out, "utf8");
        res.writeHead(status === 304 ? 200 : status, {
          "content-type": mode === "reader" ? "text/html; charset=utf-8" : "text/css; charset=utf-8",
          "content-length": String(buf.length),
          "cache-control": mode === "reader" ? "private, no-store" : "public, max-age=60",
          "x-pine-final-url": encodeURIComponent(finalUrl),
        });
        res.end(buf);
        return;
      }
      return streamThrough(req, res, up, cfg);
    }
  } catch (err) {
    return sendReaderError(res, err, current?.href || rawTarget);
  }
}

function streamThrough(req, res, up, cfg) {
  const headers = {};
  for (const [k, v] of Object.entries(up.headers)) {
    const key = k.toLowerCase();
    if (HOP_HEADERS.has(key)) continue;
    if (key === "content-security-policy" || key === "x-frame-options") continue; // assets must load in reader
    headers[key] = v;
  }
  // Missing content-length with keep-alive upstreams: just close-delimit.
  res.writeHead(up.statusCode || 200, headers);
  let sent = 0;
  up.on("data", (c) => {
    sent += c.length;
    if (sent > cfg.maxStream) {
      up.destroy();
      res.destroy();
      return;
    }
    if (!res.write(c)) up.pause();
  });
  res.on("drain", () => up.resume());
  up.on("end", () => res.end());
  up.on("error", () => res.destroy());
  req.on("close", () => up.destroy());
}

function sendReaderError(res, err, targetUrl) {
  const status = err instanceof TargetError ? err.status : 502;
  let message = err?.message || "Something went wrong.";
  if (err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN") message = "That hostname couldn't be resolved — check the address.";
  else if (err?.code === "ECONNREFUSED") message = "That server refused the connection.";
  else if (err?.code === "EBLOCKED" || /private/i.test(message)) message = "That address is private or blocked on this server.";
  else if (/timed out/i.test(message)) message = "That site took too long to respond.";
  else if (/certificate|tls|ssl/i.test(String(err?.code || "") + message)) message = "That site's TLS certificate couldn't be verified.";
  if (!res.headersSent) {
    const page = readerErrorPage(message, targetUrl);
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(page) });
    res.end(page);
  } else {
    res.destroy();
  }
}
