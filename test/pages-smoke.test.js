/* GitHub Pages smoke test — builds dist-pages into a temp directory,
 * serves it below a fake /Relay-hub/ project path, and boots the generated
 * client in jsdom. This deliberately has no Pine API, chat websocket, or
 * same-origin Wisp server: it proves the static edition stands on its own
 * and degrades Reader/chat honestly instead of calling dead endpoints. */
import http from "node:http";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import { build } from "esbuild";
import { buildPages } from "../scripts/build-pages.mjs";
import { createStatic } from "../src/static.js";

let outDir;
let staticServer;
let fixture;
let dom;
let base;
let fixtureUrl;
let pageErrors;
let requestPaths;

const listen = (server) => new Promise((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve(server.address().port))
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, label, ms = 12000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < ms) {
    try {
      const value = fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

before(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), "pine-pages-smoke-"));
  // Port 1 refuses immediately. That keeps this test offline and quick:
  // jsdom has no service worker, so Scramjet must use Pine's fallback path.
  await buildPages({ outDir, wispUrls: ["ws://127.0.0.1:1/"] });

  requestPaths = [];
  const serveStatic = createStatic({
    mounts: [{ prefix: "/Relay-hub/", dir: outDir, maxAge: 0 }],
    fileMounts: new Map([
      ["/Relay-hub/", { file: path.join(outDir, "index.html"), maxAge: 0 }],
    ]),
  });
  staticServer = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://pages.test");
    requestPaths.push(pathname);
    if (!(await serveStatic(req, res, pathname))) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  const staticPort = await listen(staticServer);
  base = `http://127.0.0.1:${staticPort}/Relay-hub/`;

  fixture = http.createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>Direct Fixture</title><h1>Direct target</h1>");
    }
    res.writeHead(404);
    return res.end();
  });
  fixtureUrl = `http://127.0.0.1:${await listen(fixture)}/page`;

  // jsdom cannot execute module scripts, so bundle the *generated* app and
  // inject it after pages-config.js has run exactly as it would on Pages.
  const bundle = await build({
    entryPoints: [path.join(outDir, "js/app.js")],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });

  pageErrors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (err) => {
    const text = String(err.detail?.stack || err.detail?.message || err.message || err);
    if (/Not implemented/.test(text)) return;
    pageErrors.push(text.split("\n").slice(0, 3).join("\n"));
  });
  vc.on("error", (message) => pageErrors.push(`console.error: ${message}`));

  dom = await JSDOM.fromURL(base, {
    resources: "usable",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.scrollTo = () => {};
      window.fetch = (url, options) => fetch(new URL(url, base), options);
      // Seed Reader as the saved default: static boot must move it to the
      // full Scramjet engine instead of aiming tabs at /api/fetch.
      window.localStorage.setItem("pine.v1", JSON.stringify({
        settings: { engine: "reader" },
        profile: { name: "pages-smoke" },
        wallet: { coins: 150, xp: 0, owned: [], lastDaily: "2000-1-1" },
        history: [],
        bookmarks: [],
        seenIntro: true,
      }));
    },
  });

  const script = dom.window.document.createElement("script");
  script.textContent = bundle.outputFiles[0].text;
  dom.window.document.body.appendChild(script);
});

after(async () => {
  try { dom?.window.close(); } catch { /* already closed */ }
  for (const server of [staticServer, fixture]) {
    server?.closeAllConnections?.();
    server?.close();
  }
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

test("generated GitHub Pages edition boots and works below a project subpath", { timeout: 120000 }, async () => {
  const w = dom.window;
  const $ = (selector, root = w.document) => root.querySelector(selector);
  const clickView = (view) => w.document.querySelector(`.rail-btn[data-view="${view}"]`).click();

  await waitFor(() => $("#quick-grid").children.length >= 8, "static hub boot");
  assert.equal(w.document.documentElement.dataset.edition, "static");
  assert.match($("#greeting").textContent, /pages-smoke/);
  assert.equal($("#hint-engine-name").textContent, "Scramjet", "saved Reader default is normalised");
  assert.ok(requestPaths.includes("/Relay-hub/pages-config.js"));
  assert.ok(requestPaths.includes("/Relay-hub/css/app.css"));

  // Local AI still works without /api/answer.
  clickView("ai");
  await sleep(100);
  $("#ai-input").value = "17 * 24 + sqrt(81)";
  $("#ai-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(
    () => [...w.document.querySelectorAll(".ai-msg.bot")].some((el) => el.textContent.includes("417")),
    "local AI maths"
  );

  // Chat reports the static limitation once rather than retrying /chat.
  clickView("chat");
  await waitFor(() => $("#chat-status").textContent.includes("static edition"), "static chat status");
  assert.equal($("#chat-input").disabled, true);
  assert.match($("#chat-messages").textContent, /unavailable in the 100% GitHub Pages edition/);

  // Settings explain the runtime and disable Reader everywhere relevant.
  clickView("settings");
  await sleep(150);
  assert.match($("#server-stats").textContent, /GitHub Pages edition/);
  assert.equal($("#set-engine").value, "scramjet");
  assert.equal($("#set-engine").querySelector('option[value="reader"]').disabled, true);
  assert.equal($("#engine-sel").querySelector('option[value="reader"]').disabled, true);
  assert.match($("#set-wisp").placeholder, /127\.0\.0\.1:1/);

  // A built-in game is loaded below /Relay-hub/, not the domain root.
  clickView("play");
  await sleep(100);
  $("#play-search").value = "memory";
  $("#play-search").dispatchEvent(new w.Event("input", { bubbles: true }));
  await sleep(100);
  $("#play-grid").children[0].click();
  const gameDoc = await waitFor(() => {
    const frame = $("#game-frame");
    const doc = frame.contentDocument;
    return doc?.querySelectorAll(".card").length === 16 ? doc : null;
  }, "memory game below the Pages subpath");
  assert.equal(new URL($("#game-frame").src).pathname, "/Relay-hub/games/memory.html");
  assert.ok(gameDoc);
  $("#game-close").click();

  // jsdom cannot run the Scramjet service worker. Static fallback must be
  // Direct (Reader does not exist here), pointed at the exact target.
  clickView("home");
  await sleep(100);
  $("#home-input").value = fixtureUrl;
  $("#home-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => $("#engine-sel").value === "direct", "static Direct fallback");
  const frame = await waitFor(() => w.document.querySelector("#frames iframe"), "browser tab frame");
  await waitFor(() => frame.src === fixtureUrl, "Direct iframe target");
  assert.equal(frame.src, fixtureUrl);

  assert.ok(
    !requestPaths.some((requestPath) => requestPath.includes("/api/")),
    `static edition must not call Pine APIs; saw ${requestPaths.join(", ")}`
  );
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
});
