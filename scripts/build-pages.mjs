/* Build Pine's 100%-GitHub edition for GitHub Pages.
 *
 * GitHub Pages can only serve static files, so this build copies the hub
 * from public/, adds the same pinned Scramjet/controller/transport bundles
 * the Node server mounts from node_modules, rewrites the generated copy
 * for a project subpath (for example /Relay-hub/), and injects a small
 * pages-config.js that switches the client to public Wisp endpoints.
 *
 * The source tree is never modified: the Node edition keeps serving `/`.
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_OUT_DIR = path.join(DEFAULT_ROOT, "dist-pages");

export const DEFAULT_PUBLIC_WISP_URLS = Object.freeze([
  "wss://wisp.webmc.fun/",
  "wss://wisp.freewisp.org/",
  "wss://wisp.mercurywork.shop/",
  "wss://wisp.terbiumon.top/wisp/",
  "wss://anura.pro/",
]);

/* Keep this list aligned with server.js's fileMounts. */
export const BUNDLE_FILES = Object.freeze([
  ["node_modules/@mercuryworkshop/scramjet/dist/scramjet.js", "scram/scramjet.js"],
  ["node_modules/@mercuryworkshop/scramjet/dist/scramjet.wasm", "scram/scramjet.wasm"],
  ["node_modules/@mercuryworkshop/scramjet-utils/dist/scramjet-utils.js", "scram/scramjet-utils.js"],
  ["node_modules/@mercuryworkshop/scramjet-controller/dist/controller.api.js", "controller/controller.api.js"],
  ["node_modules/@mercuryworkshop/scramjet-controller/dist/controller.inject.js", "controller/controller.inject.js"],
  ["node_modules/@mercuryworkshop/scramjet-controller/dist/controller.sw.js", "controller/controller.sw.js"],
  ["node_modules/@mercuryworkshop/libcurl-transport/dist/index.js", "clients/libcurl-client.js"],
  ["node_modules/libcurl.js/libcurl.wasm", "clients/libcurl.wasm"],
  ["node_modules/@mercuryworkshop/epoxy-transport/dist/index.js", "clients/epoxy-client.js"],
  ["node_modules/@mercuryworkshop/epoxy-tls/full/epoxy.wasm", "clients/epoxy.wasm"],
]);

function normaliseWisp(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withScheme = /^wss?:\/\//i.test(raw) ? raw : `wss://${raw}`;
  const url = new URL(withScheme);
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new Error(`Invalid Wisp URL (expected ws:// or wss://): ${value}`);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function wispUrlsFromEnv(env = process.env) {
  const override = String(env.PINE_PAGES_WISP || "")
    .split(",")
    .map(normaliseWisp)
    .filter(Boolean);
  return Object.freeze(override.length ? [...new Set(override)] : [...DEFAULT_PUBLIC_WISP_URLS]);
}

export function transformIndex(html) {
  let out = String(html);

  // Project Pages sites live below /<repo>/, so root-absolute asset URLs
  // would escape the project and 404. Internal page assets become relative
  // to the document; the app's JS separately derives its runtime base.
  out = out.replace(/\b(href|src)="\/(?!\/)/g, '$1="');

  // Copy that specifically describes the server edition.
  out = out.replace(
    "encrypted WebSocket to this server",
    "encrypted WebSocket to a public Wisp endpoint",
  );
  out = out.replace(
    "Traffic travels over an encrypted <b>Wisp</b> tunnel to this server — filters see one connection, to here.",
    "Traffic travels over an encrypted <b>Wisp</b> tunnel to a public endpoint — filters see one connection, not the sites inside it.",
  );
  out = out.replace(
    "Logins &amp; cookies stay in <b>your</b> browser. History too. The server sees none of it.",
    "Logins &amp; cookies stay in <b>your</b> browser. History too. GitHub serves only these static files.",
  );
  out = out.replace(
    "Custom Wisp server <span class=\"field-hint\">blank = this server</span>",
    "Custom Wisp server <span class=\"field-hint\">blank = public endpoints with failover</span>",
  );
  out = out.replace("<h4>Server</h4>", "<h4>Runtime</h4>");

  if (!out.includes("pages-config.js")) {
    const appScript = '<script type="module" src="js/app.js"></script>';
    if (!out.includes(appScript))
      throw new Error("Could not find the app module script in public/index.html");
    out = out.replace(appScript, `<script src="pages-config.js"></script>\n${appScript}`);
  }
  return out;
}

export function transformServiceWorker(js) {
  return String(js).replace(
    'importScripts("/controller/controller.sw.js")',
    'importScripts("controller/controller.sw.js")',
  );
}

export function transformManifest(manifest) {
  const parsed = typeof manifest === "string" ? JSON.parse(manifest) : structuredClone(manifest);
  parsed.start_url = ".";
  parsed.scope = ".";
  parsed.icons = (parsed.icons || []).map((icon) => ({
    ...icon,
    src: String(icon.src || "favicon.svg").replace(/^\//, ""),
  }));
  return parsed;
}

async function requireFile(file, label) {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    return info;
  } catch {
    throw new Error(`Missing ${label}: ${file}. Run npm ci --ignore-scripts first.`);
  }
}

export async function buildPages({
  root = DEFAULT_ROOT,
  outDir = DEFAULT_OUT_DIR,
  wispUrls = wispUrlsFromEnv(),
} = {}) {
  const publicDir = path.join(root, "public");
  await requireFile(path.join(publicDir, "index.html"), "hub entry point");
  for (const [from] of BUNDLE_FILES) await requireFile(path.join(root, from), "proxy bundle");

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await cp(publicDir, outDir, { recursive: true });

  let bytes = 0;
  for (const [from, to] of BUNDLE_FILES) {
    const source = path.join(root, from);
    const dest = path.join(outDir, to);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(source, dest);
    bytes += (await stat(dest)).size;
  }

  const indexPath = path.join(outDir, "index.html");
  await writeFile(indexPath, transformIndex(await readFile(indexPath, "utf8")));

  const swPath = path.join(outDir, "sw.js");
  await writeFile(swPath, transformServiceWorker(await readFile(swPath, "utf8")));

  const manifestPath = path.join(outDir, "manifest.webmanifest");
  const manifest = transformManifest(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const config = [
    "/* Generated by scripts/build-pages.mjs — GitHub Pages edition. */",
    "window.PINE_STATIC = true;",
    `window.PINE_WISP = ${JSON.stringify(wispUrls)};`,
    "",
  ].join("\n");
  await writeFile(path.join(outDir, "pages-config.js"), config);
  await writeFile(path.join(outDir, ".nojekyll"), "");

  return { outDir, bundleBytes: bytes, wispUrls };
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  try {
    const outDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUT_DIR;
    const result = await buildPages({ outDir });
    console.log(`GitHub Pages build ready: ${result.outDir}`);
    console.log(`Proxy bundles: ${(result.bundleBytes / 1024 / 1024).toFixed(2)} MiB`);
    console.log(`Public Wisp failover: ${result.wispUrls.join(", ")}`);
  } catch (err) {
    console.error(`Pages build failed: ${err.message}`);
    process.exitCode = 1;
  }
}
