#!/usr/bin/env node
'use strict';

/*
 * Relay — a self-hosted web proxy with a launcher-style home screen.
 *
 * Architecture
 * ------------
 *   server.js             this file: routing, sessions, statics, API
 *   src/url.js            URL mapping + SSRF validation
 *   src/upstream.js       careful HTTP client (dns pinning, redirects, cookies)
 *   src/cookies.js        per-session server-side cookie jar
 *   src/rewrite/html.js   HTML + CSS rewriting and the in-page runtime
 *   src/cache.js          small in-memory response cache
 *   src/net.js            compression + streaming helpers
 *
 * Zero runtime dependencies. Node.js 18+.
 */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream');

const {
  PREFIX,
  b64url,
  unb64url,
  decodeTargetSegment,
  validateTarget,
  normaliseTarget,
  TargetError,
  proxifyUrl,
  targetFromProxyUrl,
  rewriteUrl,
  looksLikeHost,
} = require('./src/url');
const upstream = require('./src/upstream');
const cookies = require('./src/cookies');
const html = require('./src/rewrite/html');
const cache = require('./src/cache');
const netlib = require('./src/net');
const { relayHeaders } = require('./src/headers');
const { friendlyError } = require('./src/errors');

/* ------------------------------------------------------------------ */
/*  Configuration                                                     */
/* ------------------------------------------------------------------ */

const VERSION = '2.1.0';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const AUTH_USER = process.env.RELAY_USER || 'relay';
const AUTH_PASS = process.env.RELAY_PASS || '';
const REPO_URL = process.env.RELAY_REPO_URL || '';
const LOG_ON = process.env.RELAY_LOG !== '0';
const LOG_LEVEL = process.env.RELAY_LOG_LEVEL || (process.env.RELAY_LOG === '0' ? 'silent' : 'info');

const TIMEOUT = Number(process.env.RELAY_TIMEOUT || 30000);
const MAX_HTML = Number(process.env.RELAY_MAX_HTML || 12 * 1024 * 1024);
const MAX_BODY = Number(process.env.RELAY_MAX_BODY || 16 * 1024 * 1024);
const MAX_STREAM = Number(process.env.RELAY_MAX_STREAM || 512 * 1024 * 1024);
const CACHE_TTL = Number(process.env.RELAY_CACHE_TTL || 60) * 1000;
const CACHE_MAX = Number(process.env.RELAY_CACHE_MAX || 64) * 1024 * 1024;

const ISOLATE = process.env.RELAY_ISOLATE === '1';
const TRUST_PROXY = process.env.RELAY_TRUST_PROXY !== '0';
const NO_COMPRESS = process.env.RELAY_NO_COMPRESS === '1';
const RATE_LIMIT = Number(process.env.RELAY_RATE_LIMIT || 0); // requests/min/ip, 0 = off
const INJECT = process.env.RELAY_INJECT || '';
const DEFAULT_ENGINE = process.env.RELAY_ENGINE || 'duckduckgo';

const PUBLIC_DIR = path.join(__dirname, 'public');

const SEARCH_ENGINES = {
  duckduckgo: 'https://html.duckduckgo.com/html/?q=',
  bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q=',
  wikipedia: 'https://en.wikipedia.org/w/index.php?search=',
  startpage: 'https://www.startpage.com/sp/search?query=',
  mojeek: 'https://www.mojeek.com/search?q=',
  google: 'https://www.google.com/search?q=',
  ecosia: 'https://www.ecosia.org/search?q=',
};

/* ------------------------------------------------------------------ */
/*  Logging                                                           */
/* ------------------------------------------------------------------ */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const level = LEVELS[LOG_LEVEL] === undefined ? 3 : LEVELS[LOG_LEVEL];

function log(...args) {
  if (level >= LEVELS.info) console.log(...args);
}
function debug(...args) {
  if (level >= LEVELS.debug) console.log(...args);
}
function warn(...args) {
  if (level >= LEVELS.warn) console.warn(...args);
}
function error(...args) {
  if (level >= LEVELS.error) console.error(...args);
}

function colour(code, s) {
  if (!process.stdout.isTTY) return s;
  return `\u001b[${code}m${s}\u001b[0m`;
}

function statusColour(status) {
  if (status >= 500) return colour(31, String(status));
  if (status >= 400) return colour(33, String(status));
  if (status >= 300) return colour(36, String(status));
  return colour(32, String(status));
}

/* ------------------------------------------------------------------ */
/*  Sessions                                                          */
/* ------------------------------------------------------------------ */

const SESSION_COOKIE = 'relay_s';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function sessionFromRequest(req) {
  const m = /(?:^|;\s*)relay_s=([A-Za-z0-9_-]{8,64})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

function newSession() {
  return crypto.randomBytes(18).toString('base64url');
}

/* ------------------------------------------------------------------ */
/*  Auth                                                              */
/* ------------------------------------------------------------------ */

const authFailures = new Map();

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Compare anyway to keep timing flat-ish.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function checkAuth(req, res) {
  if (!AUTH_PASS) return true;

  const ip = clientIp(req);
  const failure = authFailures.get(ip);
  if (failure && failure.count >= 10 && Date.now() - failure.at < 15 * 60 * 1000) {
    res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '900' });
    res.end('Too many failed sign-in attempts. Try again later.');
    return false;
  }

  const header = req.headers.authorization || '';
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (m) {
    let decoded = '';
    try {
      decoded = Buffer.from(m[1], 'base64').toString('utf8');
    } catch {
      decoded = '';
    }
    const idx = decoded.indexOf(':');
    const user = idx >= 0 ? decoded.slice(0, idx) : '';
    const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    if (safeEqual(user, AUTH_USER) && safeEqual(pass, AUTH_PASS)) {
      authFailures.delete(ip);
      return true;
    }
  }

  const entry = authFailures.get(ip) || { count: 0, at: Date.now() };
  entry.count++;
  entry.at = Date.now();
  authFailures.set(ip, entry);

  res.writeHead(401, {
    'www-authenticate': 'Basic realm="Relay", charset="UTF-8"',
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end('Relay — authentication required');
  return false;
}

/* ------------------------------------------------------------------ */
/*  Rate limiting                                                     */
/* ------------------------------------------------------------------ */

const buckets = new Map();

function rateLimited(req, res) {
  if (!RATE_LIMIT) return false;
  const ip = clientIp(req);
  const now = Date.now();
  const windowStart = Math.floor(now / 60000);
  let b = buckets.get(ip);
  if (!b || b.window !== windowStart) {
    b = { window: windowStart, count: 0 };
    buckets.set(ip, b);
    if (buckets.size > 10000) {
      for (const [k, v] of buckets) if (v.window !== windowStart) buckets.delete(k);
    }
  }
  b.count++;
  if (b.count > RATE_LIMIT) {
    const retry = 60 - Math.floor((now % 60000) / 1000);
    res.writeHead(429, {
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': String(retry),
      'cache-control': 'no-store',
    });
    res.end(`Rate limit reached (${RATE_LIMIT} requests/minute).`);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Static files                                                      */
/* ------------------------------------------------------------------ */

const PAGES = {
  '/': 'hub.html',
  '/hub': 'hub.html',
  '/browse': 'browse.html',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const pageCache = new Map();

function readPage(file) {
  const full = path.join(PUBLIC_DIR, file);
  const st = fs.statSync(full);
  const hit = pageCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.buf;
  const buf = fs.readFileSync(full);
  pageCache.set(file, { buf, mtime: st.mtimeMs });
  return buf;
}

function sendBuffer(req, res, status, headers, buf) {
  const etag = '"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 27) + '"';
  const incoming = req.headers['if-none-match'];
  const h = Object.assign({ etag }, headers);
  if (incoming && incoming.split(/\s*,\s*/).includes(etag)) {
    res.writeHead(304, { etag, 'cache-control': h['cache-control'] || 'no-cache' });
    return res.end();
  }
  netlib.sendCompressed(req, res, status, h, buf);
}

function servePage(req, res, file) {
  let buf;
  try {
    buf = readPage(file);
  } catch (e) {
    error('UI file missing:', file, e.message);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('UI file missing: ' + file);
  }
  sendBuffer(req, res, 200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  }, buf);
}

function serveAsset(req, res, pathname) {
  const inner = pathname.replace(/^\/assets/, '') || '/';
  let decoded;
  try {
    decoded = decodeURIComponent(inner);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('Bad request');
  }
  const target = path.resolve(PUBLIC_DIR, '.' + decoded);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('Forbidden');
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(target).toLowerCase();
    const immutable = /\.(jpg|jpeg|png|gif|webp|avif|svg|woff2|woff|ttf|ico)$/.test(ext);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=604800' : 'public, max-age=60',
      'content-length': String(st.size),
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#22d3ee"/>
</linearGradient></defs>
<rect width="64" height="64" rx="16" fill="url(#g)"/>
<path d="M16 40c0-12 9.5-21 21-21 7 0 12.6 3.2 16 8.2" fill="none" stroke="#06231b" stroke-width="5" stroke-linecap="round"/>
<path d="M48 24c0 12-9.5 21-21 21-7 0-12.6-3.2-16-8.2" fill="none" stroke="#06231b" stroke-width="5" stroke-linecap="round"/>
<circle cx="48" cy="34" r="4.5" fill="#06231b"/><circle cx="16" cy="30" r="4.5" fill="#06231b"/>
</svg>`;

/* ------------------------------------------------------------------ */
/*  Error pages                                                       */
/* ------------------------------------------------------------------ */

function errorPage(req, res, status, target, message, extra = '') {
  const [title, ...rest] = String(message || 'Something went wrong.').split('\n');
  const subtitle = rest.join(' ').trim() || 'The site may block proxies, be offline, or take too long to answer.';
  const readerHref = target
    ? `/fetch?url=${encodeURIComponent(target)}&m=1`
    : '/';
  const retryHref = target ? '/browse?url=' + encodeURIComponent(target) : '/';

  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay — couldn’t load page</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
 background:radial-gradient(900px 500px at 20% -10%,rgba(34,211,238,.12),transparent 60%),
            radial-gradient(700px 400px at 90% 0%,rgba(129,140,248,.12),transparent 55%),#06090e;
 color:#e8eef7;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}
.card{max-width:600px;width:100%;background:rgba(13,20,30,.82);border:1px solid rgba(148,163,184,.18);
 border-radius:18px;padding:30px;box-shadow:0 30px 80px -30px rgba(0,0,0,.8)}
.badge{display:inline-flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.16em;
 text-transform:uppercase;color:#fca5a5;font-weight:600;margin-bottom:14px}
.dot{width:7px;height:7px;border-radius:99px;background:#f87171;box-shadow:0 0 12px #f87171}
h1{font-size:23px;line-height:1.25;letter-spacing:-.02em;margin:0 0 8px;font-weight:650}
p{margin:0 0 18px;color:#93a3b8;font-size:14px}
.url{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(6,9,14,.7);
 border:1px solid rgba(148,163,184,.14);border-radius:10px;padding:10px 12px;color:#a7b4c6;
 word-break:break-all;margin-bottom:22px}
.row{display:flex;gap:10px;flex-wrap:wrap}
a.btn{display:inline-flex;align-items:center;gap:7px;text-decoration:none;font-weight:600;font-size:13px;
 padding:9px 15px;border-radius:10px;border:1px solid rgba(148,163,184,.2);color:#e8eef7}
a.primary{background:linear-gradient(135deg,#34d399,#22d3ee);color:#04110c;border:0}
small{color:#6b7a8f;font-size:11.5px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;color:#c7d4e6}
</style></head><body><div class="card">
<div class="badge"><span class="dot"></span>Relay · request failed${status ? ` · ${status}` : ''}</div>
<h1>${html.escapeHtml(title)}</h1>
<p>${html.escapeHtml(subtitle)}</p>
${target ? `<div class="url">${html.escapeHtml(target)}</div>` : ''}
<div class="row">
  <a class="btn primary" href="${html.escapeAttr(retryHref)}">Try again</a>
  <a class="btn" href="${html.escapeAttr(readerHref)}">Reader mode</a>
  <a class="btn" href="/">← Relay home</a>
</div>
${extra ? `<p style="margin-top:18px"><small>${extra}</small></p>` : ''}
</div></body></html>`;

  res.writeHead(status || 502, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

/* ------------------------------------------------------------------ */
/*  Reading request bodies                                            */
/* ------------------------------------------------------------------ */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        const err = new Error('Request body too large');
        err.code = 'ETOOLARGE';
        return reject(err);
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/*  Charset handling                                                  */
/* ------------------------------------------------------------------ */

function detectCharset(contentType, buf) {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  if (m) return m[1].toLowerCase();
  if (buf && buf.length) {
    const head = buf.subarray(0, 4096).toString('latin1');
    const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
    if (meta) return meta[1].toLowerCase();
  }
  return 'utf-8';
}

function decodeBuffer(buf, charset) {
  try {
    return new TextDecoder(charset === 'iso-8859-1' ? 'windows-1252' : charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

/* ------------------------------------------------------------------ */
/*  Upstream headers → downstream headers                             */
/* ------------------------------------------------------------------ */

/** Headers we send on proxied documents to contain hostile pages. */
function frameHeaders(reader) {
  const sandbox = ISOLATE
    ? 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'
    : 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-same-origin';
  void sandbox;
  return {
    'x-content-type-options': 'nosniff',
    // We deliberately do NOT send a sandbox CSP: proxied sites need their own
    // cookies/localStorage, and a sandboxed origin would break logins. The
    // iframe in browse.html applies the sandbox there instead.
    'referrer-policy': 'no-referrer-when-downgrade',
    'cross-origin-resource-policy': 'cross-origin',
  };
}

/* ------------------------------------------------------------------ */
/*  Core: proxy a request                                             */
/* ------------------------------------------------------------------ */

/** Accepts either a URL or URLSearchParams. */
function wantsReader(source) {
  if (!source) return false;
  if (typeof source.get === 'function') return source.get('m') === '1';
  if (source.searchParams) return source.searchParams.get('m') === '1';
  return false;
}

/**
 * Proxy one upstream request and relay it downstream.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} target
 * @param {{reader?:boolean, forceStream?:boolean, isDocument?:boolean, method?:string}} opts
 */
async function proxyRequest(req, res, target, opts = {}) {
  const started = Date.now();
  const sessionId = sessionFromRequest(req) || newSession();
  const needsSessionCookie = !sessionFromRequest(req);

  const method = (opts.method || req.method || 'GET').toUpperCase();
  let body = null;

  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = await readBody(req, MAX_BODY);
    } catch (e) {
      return errorPage(req, res, 413, target, 'Request body was too large to relay.');
    }
  }

  const forwardHeaders = {
    accept: req.headers.accept || '*/*',
    'accept-language': req.headers['accept-language'] || 'en-GB,en;q=0.9,en-US;q=0.8',
  };
  if (req.headers['content-type']) forwardHeaders['content-type'] = req.headers['content-type'];
  if (req.headers.range) forwardHeaders.range = req.headers.range;
  if (req.headers['if-none-match']) forwardHeaders['if-none-match'] = req.headers['if-none-match'];
  if (req.headers['if-modified-since']) forwardHeaders['if-modified-since'] = req.headers['if-modified-since'];
  // Referer: map our proxy URL back to the real one so hotlink checks pass.
  const referer = req.headers.referer;
  if (referer) {
    const mapped = refererToTarget(referer);
    if (mapped) forwardHeaders.referer = mapped;
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT);
  let ups;
  try {
    ups = await upstream.fetchWithRedirects(target, {
      method,
      headers: forwardHeaders,
      body,
      timeout: TIMEOUT,
      signal: abort.signal,
      cookieJar: cookies,
      sessionId,
      userAgent: undefined,
      selfHosts: selfHosts(),
    });
  } catch (err) {
    clearTimeout(timer);
    log(`${colour(35, method)} ${target} → ${colour(31, 'ERROR')} ${err.code || err.message}`);
    return errorPage(req, res, 502, target, friendlyError(err, TIMEOUT));
  }
  clearTimeout(timer);

  const finalUrl = ups.finalUrl || target;
  const contentType = ups.headers['content-type'] || '';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const status = ups.status;

  const headers = relayHeaders(ups.headers);
  headers['cache-control'] = ups.headers['cache-control'] || 'no-cache';
  Object.assign(headers, frameHeaders(opts.reader));

  // Location header: keep redirects inside the proxy.
  if (ups.headers.location) {
    const rewritten = rewriteUrl(ups.headers.location, { base: finalUrl, mode: 'link', reader: opts.reader });
    headers.location = rewritten;
  }

  if (needsSessionCookie) {
    headers['set-cookie'] = sessionCookie(res, sessionId);
  }

  const isHtml = mime === 'text/html' || mime === 'application/xhtml+xml';
  const isCss = mime === 'text/css';
  const isText = /^text\//.test(mime) || /[+/](json|xml|javascript)$/.test(mime);

  if (method === 'HEAD' || status === 204 || status === 205) {
    res.writeHead(status, headers);
    ups.stream.destroy();
    return res.end();
  }

  // ---------- HTML: rewrite ----------
  if (isHtml && !opts.forceStream) {
    const declared = Number(ups.headers['content-length'] || 0);
    if (!declared || declared <= MAX_HTML) {
      let buf;
      try {
        buf = await upstream.readAll(ups.stream, MAX_HTML);
      } catch (err) {
        if (err.code === 'ETOOLARGE') {
          // Too big to rewrite: stream unrewritten rather than fail.
          res.writeHead(status, headers);
          return res.end();
        }
        return errorPage(req, res, 502, finalUrl, friendlyError(err, TIMEOUT));
      }
      if (buf.length <= MAX_HTML) {
        // Cache key includes the session (the nonce is embedded) and mode.
        const cacheKey = cache.constructor.key(sessionId, finalUrl, opts.reader ? 'r' : 'f');
        const cached = CACHE_TTL ? cache.get(cacheKey) : null;
        let outBuf;
        if (cached) {
          outBuf = cached.value.body;
          stats.cacheHits = (stats.cacheHits || 0) + 1;
        } else {
          const charset = detectCharset(contentType, buf);
          const source = decodeBuffer(buf, charset);
          let out;
          try {
            out = html.rewriteHtml(source, {
              url: finalUrl,
              reader: !!opts.reader,
              nonce: sessionId,
            });
          } catch (err) {
            warn('rewrite failed:', err.message);
            out = source;
          }
          out = injectSnippet(out);
          outBuf = Buffer.from(out, 'utf8');
          if (CACHE_TTL) cache.set(cacheKey, { body: outBuf });
        }
        const h = Object.assign({}, headers, {
          'content-type': 'text/html; charset=utf-8',
        });
        if (opts.noStore) h['cache-control'] = 'no-store';
        sendRewritten(req, res, status, h, outBuf);
        log(
          `${colour(35, method)} ${finalUrl} → ${statusColour(status)} html ${buf.length}b ` +
            `${Date.now() - started}ms${opts.reader ? colour(90, ' [reader]') : ''}`
        );
        return;
      }
    }
    // Fall through to streaming rewrite for enormous documents.
    const ctx = { base: finalUrl, target: finalUrl, reader: !!opts.reader, nonce: sessionId };
    const headInject =
      `<meta name="referrer" content="unsafe-url"><meta name="relay-target" content="${html.escapeAttr(finalUrl)}">` +
      html.clientRuntime(ctx) +
      (opts.reader ? '<style>' + html.readerStylesInline() + '</style>' : '');
    const rewriter = new html.StreamRewriter(ctx, headInject);
    res.writeHead(status, Object.assign({}, headers, { 'content-type': 'text/html; charset=utf-8' }));
    const decoder = new TextDecoder(detectCharset(contentType, Buffer.alloc(0)));
    ups.stream.on('data', (chunk) => {
      const text = decoder.decode(chunk, { stream: true });
      const out = rewriter.write(text);
      if (out) res.write(out);
    });
    ups.stream.on('end', () => {
      const tail = decoder.decode();
      const out = (tail ? rewriter.write(tail) : '') + rewriter.end();
      if (out) res.write(out);
      res.end();
    });
    ups.stream.on('error', () => res.destroy());
    log(`${colour(35, method)} ${finalUrl} → ${statusColour(status)} html (streamed)`);
    return;
  }

  // ---------- CSS: rewrite ----------
  if (isCss) {
    let buf;
    try {
      buf = await upstream.readAll(ups.stream, MAX_HTML);
    } catch (err) {
      return errorPage(req, res, 502, finalUrl, friendlyError(err, TIMEOUT));
    }
    const source = decodeBuffer(buf, detectCharset(contentType, buf));
    const out = html.rewriteCss(source, finalUrl, { reader: !!opts.reader });
    sendRewritten(req, res, status, Object.assign({}, headers, {
      'content-type': 'text/css; charset=utf-8',
    }), Buffer.from(out, 'utf8'));
    log(`${colour(35, method)} ${finalUrl} → ${statusColour(status)} css ${buf.length}b ${Date.now() - started}ms`);
    return;
  }

  // ---------- JSON/XML/JS: pass through untouched ----------
  if (isText) {
    res.writeHead(status, headers);
    let size = 0;
    ups.stream.on('data', (c) => {
      size += c.length;
      if (size > MAX_STREAM) {
        ups.stream.destroy();
        res.destroy();
      }
    });
    ups.stream.on('error', () => res.destroy());
    res.on('close', () => ups.stream.destroy());
    return ups.stream.pipe(res);
  }

  // ---------- Everything else: stream ----------
  res.writeHead(status, headers);
  if (!ups.stream) return res.end();
  let size = 0;
  ups.stream.on('data', (c) => {
    size += c.length;
    if (size > MAX_STREAM) {
      log(`${colour(33, 'stream cap hit')} ${finalUrl}`);
      ups.stream.destroy();
      res.destroy();
    }
  });
  ups.stream.on('error', () => res.destroy());
  res.on('close', () => ups.stream.destroy());
  ups.stream.pipe(res);
  debug(`${colour(35, method)} ${finalUrl} → ${statusColour(status)} ${mime || 'binary'} ${Date.now() - started}ms`);
}

function sessionCookie(res, sessionId) {
  const existing = res.getHeader && res.getHeader('set-cookie');
  const value = `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
  if (!existing) return value;
  if (Array.isArray(existing)) return existing.concat(value);
  return [existing, value];
}

function injectSnippet(document) {
  if (!INJECT) return document;
  if (/<\/body\s*>/i.test(document)) {
    return document.replace(/<\/body\s*>/i, INJECT + '</body>');
  }
  return document + INJECT;
}

/** Rewritten document: optionally compress + cache, always revalidate-able. */
function sendRewritten(req, res, status, headers, buf) {
  if (status >= 400) {
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    return res.end(buf);
  }
  netlib.sendCompressed(req, res, status, headers, buf);
}

/* ------------------------------------------------------------------ */
/*  Referer handling                                                  */
/* ------------------------------------------------------------------ */

/** Map a proxied Referer back to the real upstream URL. */
function refererToTarget(referer) {
  try {
    const u = new URL(referer);
    const parsed = targetFromProxyUrl(u.href, u.origin);
    if (!parsed) return null;
    return parsed.target;
  } catch {
    return null;
  }
}

/**
 * Best-effort base URL for a subresource requested against the proxy origin
 * with no explicit target. Tries the Referer, then the stored page cookie.
 */
function baseForSubresource(req) {
  const fromReferer = req.headers.referer ? refererToTarget(req.headers.referer) : null;
  if (fromReferer) return fromReferer;
  const m = /(?:^|;\s*)relay_base=([^;]+)/.exec(req.headers.cookie || '');
  if (m) {
    try {
      const decoded = unb64url(decodeURIComponent(m[1]));
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function selfHosts() {
  const hosts = [];
  const env = process.env.RELAY_SELF_HOSTS || '';
  for (const h of env.split(',')) if (h.trim()) hosts.push(h.trim().toLowerCase());
  if (process.env.RELAY_HOSTNAME) hosts.push(process.env.RELAY_HOSTNAME.toLowerCase());
  hosts.push('localhost', '127.0.0.1', '::1');
  return hosts;
}

/* ------------------------------------------------------------------ */
/*  Exit node info                                                    */
/* ------------------------------------------------------------------ */

let exitCache = { at: 0, data: null };

async function getExitInfo() {
  if (exitCache.data && Date.now() - exitCache.at < 5 * 60 * 1000) return exitCache.data;

  const started = Date.now();
  let geo = null;
  let ip = null;

  const attempts = [
    async () => {
      const r = await upstream.fetchWithRedirects('https://ipwho.is/', { timeout: 8000 });
      if (r.status !== 200) throw new Error('bad status');
      const text = await upstream.readAll(r.stream, 256 * 1024);
      const j = JSON.parse(text.toString('utf8'));
      if (j.success === false) throw new Error('ipwho failed');
      return { ip: j.ip, city: j.city, region: j.region, country: j.country, countryCode: j.country_code, org: j.connection && j.connection.isp, timezone: j.timezone && j.timezone.id };
    },
    async () => {
      const r = await upstream.fetchWithRedirects('https://api.ipify.org?format=json', { timeout: 8000 });
      const text = await upstream.readAll(r.stream, 64 * 1024);
      const j = JSON.parse(text.toString('utf8'));
      return { ip: j.ip };
    },
  ];

  for (const attempt of attempts) {
    try {
      const got = await attempt();
      if (!geo && got) geo = got;
      if (!ip && got && got.ip) ip = got.ip;
      if (geo && ip) break;
    } catch {
      /* try the next provider */
    }
  }

  const data = {
    ip: ip || (geo && geo.ip) || 'unknown',
    city: (geo && geo.city) || null,
    region: (geo && geo.region) || null,
    country: (geo && geo.country) || null,
    countryCode: (geo && geo.countryCode) || null,
    org: (geo && geo.org) || null,
    timezone: (geo && geo.timezone) || null,
    latencyMs: Date.now() - started,
    requests: stats.requests,
  };
  exitCache = { at: Date.now(), data };
  return data;
}

/* ------------------------------------------------------------------ */
/*  Stats                                                             */
/* ------------------------------------------------------------------ */

const stats = {
  requests: 0,
  proxied: 0,
  errors: 0,
  bytesOut: 0,
  started: Date.now(),
};

function recordRequest(deltaBytes = 0) {
  stats.requests++;
  stats.bytesOut += deltaBytes;
}

/* ------------------------------------------------------------------ */
/*  JSON + API helpers                                                */
/* ------------------------------------------------------------------ */

function sendJson(req, res, status, obj, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }, extraHeaders);
  netlib.sendCompressed(req, res, status, headers, buf);
}

/* ------------------------------------------------------------------ */
/*  WebSocket / raw upgrade proxying                                  */
/* ------------------------------------------------------------------ */

function handleUpgrade(req, socket, head) {
  let target;
  try {
    const u = new URL(req.url, 'http://internal');
    if (u.pathname === PREFIX.ws) {
      target = u.searchParams.get('url');
    } else {
      const parsed = targetFromProxyUrl(u.href, 'http://internal');
      target = parsed && parsed.target;
    }
    if (!target) throw new Error('no target');
    target = validateTarget(target, { selfHosts: selfHosts() });
  } catch (e) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }

  const t = new URL(target.replace(/^http/, 'ws'));
  const isSecure = t.protocol === 'wss:' || t.protocol === 'https:';

  upstream.resolveSafe(t.hostname)
    .then((addrs) => {
      const options = {
        host: addrs[0].address,
        port: Number(t.port) || (isSecure ? 443 : 80),
        path: t.pathname + t.search,
        headers: Object.assign({}, req.headers, {
          host: t.host,
          origin: t.protocol === 'wss:' ? 'https://' + t.host : 'http://' + t.host,
        }),
        servername: isSecure && net.isIP(t.hostname) === 0 ? t.hostname : undefined,
      };
      delete options.headers['proxy-connection'];
      delete options.headers['sec-websocket-extensions'];

      let upstreamSocket;
      if (isSecure) {
        upstreamSocket = tls.connect(Object.assign({ rejectUnauthorized: false }, options), () => {
          upstreamSocket.write(
            `${req.method} ${options.path} HTTP/1.1\r\n` +
              Object.entries(options.headers)
                .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
                .join('\r\n') +
              '\r\n\r\n'
          );
          if (head && head.length) upstreamSocket.write(head);
          upstreamSocket.pipe(socket);
          socket.pipe(upstreamSocket);
        });
      } else {
        upstreamSocket = net.connect(options, () => {
          upstreamSocket.write(
            `${req.method} ${options.path} HTTP/1.1\r\n` +
              Object.entries(options.headers)
                .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
                .join('\r\n') +
              '\r\n\r\n'
          );
          if (head && head.length) upstreamSocket.write(head);
          upstreamSocket.pipe(socket);
          socket.pipe(upstreamSocket);
        });
      }
      const kill = () => {
        try {
          upstreamSocket.destroy();
        } catch {
          /* ignore */
        }
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      };
      upstreamSocket.on('error', kill);
      socket.on('error', kill);
      upstreamSocket.setTimeout(10 * 60 * 1000, kill);
      debug(`WS ${target}`);
    })
    .catch(() => {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      socket.destroy();
    });
}

/* ------------------------------------------------------------------ */
/*  Router                                                            */
/* ------------------------------------------------------------------ */

function parseUrl(req) {
  try {
    return new URL(req.url, 'http://relay.internal');
  } catch {
    return null;
  }
}

async function route(req, res) {
  const started = Date.now();
  const url = parseUrl(req);
  if (!url) {
    return errorPage(req, res, 400, '', 'Bad request.\nThat URL could not be parsed.');
  }
  const pathname = url.pathname;

  res.on('finish', () => {
    const ms = Date.now() - started;
    recordRequest(Number(res.getHeader && res.getHeader('content-length')) || 0);
    if (level >= LEVELS.debug) {
      debug(`${colour(90, '-')} ${req.method} ${pathname} → ${statusColour(res.statusCode)} ${ms}ms`);
    } else if (level >= LEVELS.info && (pathname === '/' || pathname.startsWith('/api'))) {
      log(`${req.method} ${pathname} → ${statusColour(res.statusCode)} ${ms}ms`);
    }
  });

  if (!checkAuth(req, res)) return;
  if (rateLimited(req, res)) return;

  /* ---------------- API ---------------- */

  if (pathname === '/api/config') {
    return sendJson(req, res, 200, {
      version: VERSION,
      repoUrl: REPO_URL,
      auth: !!AUTH_PASS,
      isolate: ISOLATE,
      engine: DEFAULT_ENGINE,
      engines: Object.keys(SEARCH_ENGINES),
      features: {
        reader: true,
        websockets: true,
        cache: CACHE_TTL > 0,
        rateLimit: RATE_LIMIT || 0,
      },
      uptimeSec: Math.round((Date.now() - stats.started) / 1000),
    });
  }

  if (pathname === '/api/ip') {
    try {
      const data = await getExitInfo();
      data.requests = stats.requests;
      return sendJson(req, res, 200, data);
    } catch (err) {
      return sendJson(req, res, 200, { ip: 'unknown', requests: stats.requests, error: friendlyError(err, TIMEOUT) });
    }
  }

  if (pathname === '/api/stats') {
    return sendJson(req, res, 200, {
      uptimeSec: Math.round((Date.now() - stats.started) / 1000),
      requests: stats.requests,
      proxied: stats.proxied,
      bytesOut: stats.bytesOut,
      cookieSessions: cookies.stats().sessions,
      cookies: cookies.stats().cookies,
      cache: cache.stats(),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      node: process.version,
    });
  }

  if (pathname === '/api/engines') {
    return sendJson(req, res, 200, { default: DEFAULT_ENGINE, engines: SEARCH_ENGINES });
  }

  // Per-session cookie inspector (so users can log out of proxied sites).
  if (pathname === '/api/cookies') {
    const sessionId = sessionFromRequest(req);
    if (!sessionId) return sendJson(req, res, 200, { cookies: [] });
    const origin = url.searchParams.get('origin');
    if (req.method === 'DELETE') {
      if (origin) cookies.clearOrigin(sessionId, origin);
      else cookies.clearSession(sessionId);
      return sendJson(req, res, 200, { ok: true });
    }
    if (!origin) return sendJson(req, res, 400, { error: 'origin is required' });
    return sendJson(req, res, 200, { origin, cookies: cookies.list(sessionId, origin) });
  }

  if (pathname === '/api/session') {
    const existing = sessionFromRequest(req);
    const sessionId = existing || newSession();
    const headers = existing ? {} : { 'set-cookie': sessionCookie(res, sessionId) };
    return sendJson(req, res, 200, { session: sessionId.slice(0, 6) + '…' }, headers);
  }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('ok');
  }

  if (pathname === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('User-agent: *\nDisallow: /fetch\nDisallow: /raw\nDisallow: /p/\nDisallow: /form/\n');
  }

  /* ---------------- UI ---------------- */

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (PAGES[pathname]) return servePage(req, res, PAGES[pathname]);
    if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
      const buf = Buffer.from(FAVICON, 'utf8');
      return sendBuffer(req, res, 200, {
        'content-type': 'image/svg+xml',
        'cache-control': 'public, max-age=86400',
      }, buf);
    }
    if (pathname.startsWith('/assets/')) return serveAsset(req, res, pathname);
  }

  /* ---------------- Proxy routes ---------------- */

  if (pathname === '/fetch' || pathname === '/raw') {
    const raw = url.searchParams.get('url');
    if (!raw) {
      return errorPage(req, res, 400, '', 'No URL was given.\nAdd ?url=https://example.com to the address.');
    }
    let target;
    try {
      target = validateTarget(raw, { selfHosts: selfHosts() });
    } catch (err) {
      return errorPage(req, res, err.status || 400, raw, err.message);
    }
    return proxyRequest(req, res, target, {
      reader: wantsReader(url),
      forceStream: pathname === '/raw',
      isDocument: pathname === '/fetch',
    });
  }

  if (pathname.startsWith('/p/')) {
    // /p/<b64url(target)>[/optional/path][?query]
    const rest = pathname.slice(3);
    const slash = rest.indexOf('/');
    const seg = slash >= 0 ? rest.slice(0, slash) : rest;
    const tail = slash >= 0 ? rest.slice(slash) : '';
    const base = decodeTargetSegment(seg);
    if (!base) {
      return errorPage(req, res, 400, '', 'That proxy link is malformed.\nTry opening the page again from the hub.');
    }
    let target;
    try {
      const combined = tail ? new URL(tail, base).href : base;
      target = validateTarget(combined + (url.search || ''), { selfHosts: selfHosts() });
    } catch (err) {
      return errorPage(req, res, err.status || 400, base, err.message);
    }
    return proxyRequest(req, res, target, {
      reader: wantsReader(url),
      isDocument: true,
    });
  }

  if (pathname.startsWith('/form/')) {
    const seg = pathname.slice('/form/'.length).split('/')[0];
    const base = decodeTargetSegment(seg);
    if (!base) {
      return errorPage(req, res, 400, '', 'That form link is malformed.');
    }
    let target;
    try {
      const withQuery = url.search ? base + url.search : base;
      target = validateTarget(withQuery, { selfHosts: selfHosts() });
    } catch (err) {
      return errorPage(req, res, err.status || 400, base, err.message);
    }
    return proxyRequest(req, res, target, { reader: wantsReader(url) });
  }

  /* ---------------- Fallback: dynamic subresource ---------------- */

  // A page inside the proxy asked for a path we don't own (e.g. it built
  // `/api/thing.json` itself). Resolve it against the page it came from.
  const fallbackBase = baseForSubresource(req);
  if (fallbackBase) {
    let target;
    try {
      target = new URL(req.url, fallbackBase).href;
      target = validateTarget(target, { selfHosts: selfHosts() });
    } catch {
      target = null;
    }
    if (target) {
      return proxyRequest(req, res, target, {
        forceStream: !(req.headers.accept || '').includes('text/html'),
      });
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('Not found');
}

/* ------------------------------------------------------------------ */
/*  Server                                                            */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    stats.errors++;
    error('Unhandled:', err);
    if (!res.headersSent) {
      try {
        return errorPage(req, res, 500, '', 'The proxy hit an unexpected error.', html.escapeHtml(err.message));
      } catch {
        /* fall through */
      }
    }
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  });
});

server.on('upgrade', handleUpgrade);

server.on('clientError', (err, socket) => {
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.requestTimeout = 0;

process.on('uncaughtException', (err) => error('uncaughtException:', err));
process.on('unhandledRejection', (err) => error('unhandledRejection:', err));

/* ------------------------------------------------------------------ */
/*  Housekeeping                                                      */
/* ------------------------------------------------------------------ */

const sweepTimer = setInterval(() => {
  cookies.sweep();
  cache.sweep();
  upstream.clearDnsCache();
}, 10 * 60 * 1000);
sweepTimer.unref();

function shutdown(signal) {
  log(`\n${signal} received — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const banner = [
      '',
      `  ${colour(36, 'Relay')} ${colour(90, 'v' + VERSION)} — a proxy for the open web`,
      '',
      `  ${colour(90, 'listening')}  http://${HOST}:${PORT}`,
      `  ${colour(90, 'auth')}       ${AUTH_PASS ? colour(32, 'basic auth on') : colour(33, 'open (set RELAY_PASS to lock)')}`,
      `  ${colour(90, 'cache')}      ${CACHE_TTL ? CACHE_TTL / 1000 + 's' : 'off'}`,
      `  ${colour(90, 'timeout')}    ${TIMEOUT / 1000}s`,
      '',
    ].join('\n');
    console.log(banner);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Set PORT to something else.`);
      process.exit(1);
    }
    console.error('Server error:', err);
    process.exit(1);
  });
}

module.exports = { server, route, proxyRequest };
