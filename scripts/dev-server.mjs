/* Local preview server.
 *
 * Serves site/ directly and mounts the same pinned engine bundles the build
 * copies out of node_modules, so you can develop without a build step.
 *
 *   npm run dev           → http://localhost:8080
 *   PORT=3000 npm run dev
 *
 * Note: the Scramjet engine needs a secure context. Browsers treat
 * http://localhost as secure, so this works locally; over a plain-HTTP
 * non-localhost host, service workers are unavailable and Relay Hub will
 * fall back to Simple mode.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_FILES, ROOT, SITE_DIR } from "./build.mjs";

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/* dist paths → node_modules sources, e.g. "/scram/scramjet.js". */
const MOUNTS = new Map(BUNDLE_FILES.map(([from, to]) => [path.posix.join("/", to), path.join(ROOT, from)]));

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(body);
}

async function resolve(urlPath) {
  if (MOUNTS.has(urlPath)) return { file: MOUNTS.get(urlPath) };

  const safe = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  let file = path.join(SITE_DIR, safe);
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = path.join(file, "index.html");
  } catch {
    // Unknown path: hand back the app shell so deep links behave like Pages.
    file = path.join(SITE_DIR, "index.html");
  }
  return { file };
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    return send(res, 400, "Bad request");
  }

  const { file } = await resolve(pathname);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": info.size,
      "cache-control": "no-store",
      "service-worker-allowed": "/",
    });
    createReadStream(file).pipe(res);
  } catch {
    send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Relay Hub dev server → http://localhost:${PORT}`);
  console.log(`Serving ${SITE_DIR} with ${MOUNTS.size} engine bundles mounted.`);
});
