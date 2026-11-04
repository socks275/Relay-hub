// Pine — static file serving with ETags, pre-compression cache and ranges.
// Mounts are explicit (public/ plus the Scramjet dist files inside
// node_modules) so there's no directory-listing or traversal surface.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const COMPRESSIBLE = new Set([".html", ".css", ".js", ".mjs", ".json", ".wasm", ".svg", ".txt", ".xml", ".webmanifest"]);
// Compressed-variant cache: key `${path}:${enc}:${mtime}:${size}`.
const compressedCache = new Map();
const COMPRESSED_CACHE_MAX = 96 * 1024 * 1024;
let compressedBytes = 0;

// mounts: [{ prefix: "/scram/", dir: "/abs/dir", maxAge: 3600, filesOnly?: Set }]
// fileMounts: Map exact path -> { file, maxAge, type? }
export function createStatic({ mounts, fileMounts }) {
  async function serveFile(req, res, filePath, maxAge) {
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    const cacheControl = maxAge === 0 ? "no-cache" : `public, max-age=${maxAge}`;

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag, "cache-control": cacheControl });
      res.end();
      return true;
    }
    const ims = req.headers["if-modified-since"];
    if (ims && new Date(ims) >= new Date(Math.floor(stat.mtimeMs / 1000) * 1000)) {
      res.writeHead(304, { etag, "cache-control": cacheControl });
      res.end();
      return true;
    }

    const headers = {
      "content-type": type,
      etag,
      "last-modified": stat.mtime.toUTCString(),
      "cache-control": cacheControl,
      "cross-origin-resource-policy": "cross-origin",
      vary: "Accept-Encoding",
    };

    // Range requests (media/games) — only for uncompressed responses.
    const range = req.headers.range;
    if (range && req.method === "GET") {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (m[1] === "") { start = Math.max(0, stat.size - end); end = stat.size - 1; }
        if (start > end || start >= stat.size) {
          res.writeHead(416, { "content-range": `bytes */${stat.size}` });
          res.end();
          return true;
        }
        end = Math.min(end, stat.size - 1);
        res.writeHead(206, {
          ...headers,
          "content-range": `bytes ${start}-${end}/${stat.size}`,
          "accept-ranges": "bytes",
          "content-length": String(end - start + 1),
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return true;
      }
    }

    const accept = String(req.headers["accept-encoding"] || "");
    const wantBr = accept.includes("br");
    const wantGz = accept.includes("gzip");
    if (COMPRESSIBLE.has(ext) && stat.size > 1024 && (wantBr || wantGz) && stat.size < 8 * 1024 * 1024) {
      const enc = wantBr ? "br" : "gzip";
      const key = `${filePath}:${enc}:${stat.mtimeMs}:${stat.size}`;
      let buf = compressedCache.get(key);
      if (!buf) {
        const raw = await fs.promises.readFile(filePath);
        buf = enc === "br"
          ? await brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
          : await gzip(raw, { level: 6 });
        if (compressedBytes + buf.length > COMPRESSED_CACHE_MAX) {
          compressedCache.clear();
          compressedBytes = 0;
        }
        compressedCache.set(key, buf);
        compressedBytes += buf.length;
      }
      res.writeHead(200, { ...headers, "content-encoding": enc, "content-length": String(buf.length) });
      res.end(req.method === "HEAD" ? undefined : buf);
      return true;
    }

    res.writeHead(200, { ...headers, "content-length": String(stat.size), "accept-ranges": "bytes" });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // Returns true if the request was handled.
  return async function staticHandler(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") return false;

    const exact = fileMounts.get(pathname);
    if (exact) return serveFile(req, res, exact.file, exact.maxAge);

    for (const mount of mounts) {
      if (!pathname.startsWith(mount.prefix)) continue;
      const rel = decodeURIComponent(pathname.slice(mount.prefix.length));
      if (mount.filesOnly && !mount.filesOnly.has(rel)) continue;
      // Refuse sourcemaps + type defs from node_modules mounts; keeps things lean.
      if (rel.endsWith(".map") || rel.includes("types/") || rel.includes("temp-types")) continue;
      const filePath = path.normalize(path.join(mount.dir, rel));
      if (filePath !== mount.dir && !filePath.startsWith(mount.dir + path.sep)) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Forbidden");
        return true;
      }
      if (rel === "" || rel.endsWith("/")) continue;
      const handled = await serveFile(req, res, filePath, mount.maxAge);
      if (handled) return true;
    }
    return false;
  };
}
