/* Relay Hub — DOM smoke test.
 *
 * Runs the real app modules against a jsdom copy of site/index.html with
 * network access stubbed out, which catches the failures unit tests can't:
 * missing element IDs, broken boot order, a tab that never renders.
 *
 * The Scramjet engine itself needs a real service worker, so it is not
 * exercised here — this covers the shell and the Simple-mode pipeline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(path.join(ROOT, "site", "index.html"), "utf8");

/** Boots a fresh Relay Hub in a jsdom window. */
async function bootApp({ html = HTML, url = "https://relay.test/" } = {}) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = dom;

  const globals = {
    window,
    document: window.document,
    location: window.location,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    FormData: window.FormData,
    URLSearchParams: window.URLSearchParams,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame?.bind(window) || ((cb) => setTimeout(cb, 0)),
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "navigator", {
    value: window.navigator,
    configurable: true,
    writable: true,
  });

  // Fresh module instances per boot, so tests do not share app state.
  await import(`../site/js/app.js?t=${Date.now()}${Math.random()}`);
  return { dom, window, document: window.document };
}

function stubFetch(handler) {
  const calls = [];
  const fn = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  Object.defineProperty(globalThis, "fetch", { value: fn, configurable: true, writable: true });
  return calls;
}

function htmlResponse(body, { type = "text/html", status = 200 } = {}) {
  return new Response(body, { status, headers: { "content-type": type } });
}

const $ = (doc, id) => doc.getElementById(id);

/* ------------------------------------------------------------------ */

test("the app boots onto a new tab page", async () => {
  const { document } = await bootApp();

  assert.equal($(document, "tabs").querySelectorAll(".tab").length, 1, "one tab on boot");
  assert.ok($(document, "views").querySelector(".ntp"), "new tab page rendered");
  assert.ok($(document, "views").querySelector(".ntp .links"), "quick links rendered");
  assert.equal($(document, "omnibox").value, "", "address bar starts empty");
});

test("the new tab button adds and activates a tab", async () => {
  const { document } = await bootApp();
  $(document, "new-tab").click();
  assert.equal($(document, "tabs").querySelectorAll(".tab").length, 2);
  assert.equal($(document, "views").querySelectorAll(".view").length, 2);
  assert.equal($(document, "tabs").querySelectorAll(".tab.active").length, 1);
});

test("closing the last tab opens a fresh one instead of an empty window", async () => {
  const { document } = await bootApp();
  $(document, "new-tab").click();
  $(document, "tabs").querySelector(".tab .tab-close").click();
  $(document, "tabs").querySelector(".tab .tab-close").click();
  assert.equal($(document, "tabs").querySelectorAll(".tab").length, 1);
  assert.ok($(document, "views").querySelector(".ntp"));
});

test("the settings drawer opens, keeps its values and closes", async () => {
  const { document } = await bootApp();
  const drawer = $(document, "settings");

  assert.equal(drawer.hidden, true);
  $(document, "btn-settings").click();
  assert.equal(drawer.hidden, false);

  const search = $(document, "set-search");
  assert.ok(search.options.length >= 8, "search engines populated");
  assert.equal(search.value, "duckduckgo");

  search.value = "google";
  search.dispatchEvent(new document.defaultView.Event("change"));
  assert.equal(JSON.parse(localStorage.getItem("relay.settings.v1")).search, "google");

  $(document, "settings-close").click();
  assert.equal(drawer.hidden, true);
});

test("Simple mode fetches, rewrites and renders a page", async () => {
  const { document } = await bootApp();
  // Pin Simple mode before navigating.
  const mode = $(document, "set-mode");
  mode.value = "simple";
  mode.dispatchEvent(new document.defaultView.Event("change"));

  const calls = stubFetch((url) =>
    htmlResponse(
      `<html><head><title>Example</title>
       <meta http-equiv="Content-Security-Policy" content="default-src 'none'"></head>
       <body><a href="/next">next</a><img src="pic.png"></body></html>`,
    ),
  );

  const omnibox = $(document, "omnibox");
  omnibox.value = "https://example.com/a/b";
  omnibox.dispatchEvent(new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  // Let the navigation promise settle.
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(calls.length >= 1, "a CORS mirror was called");
  assert.match(calls[0].url, /example\.com/, "the destination rides in the mirror URL");

  const iframe = $(document, "views").querySelector(".view.active iframe");
  assert.ok(iframe, "a browsing iframe was created");
  assert.equal(iframe.getAttribute("sandbox").includes("allow-scripts"), true, "Simple mode sandboxes the page");
  assert.ok(!iframe.getAttribute("sandbox").includes("allow-same-origin"), "Simple mode must not share our origin");

  const doc = iframe.getAttribute("srcdoc") || iframe.srcdoc || "";
  assert.match(doc, /<base href="https:\/\/example\.com\/a\/b">/, "base tag injected");
  assert.match(doc, /href="https:\/\/example\.com\/next"/, "links absolutised");
  assert.match(doc, /src="https:\/\/example\.com\/a\/pic\.png"/, "images absolutised");
  assert.doesNotMatch(doc, /content-security-policy/i, "CSP stripped");

  assert.equal($(document, "reload")?.disabled ?? $(document, "nav-reload").disabled, false, "reload enabled");
});

test("Simple mode tries the next mirror when one fails", async () => {
  const { document } = await bootApp();
  const mode = $(document, "set-mode");
  mode.value = "simple";
  mode.dispatchEvent(new document.defaultView.Event("change"));

  let attempt = 0;
  const calls = stubFetch(() => {
    attempt += 1;
    if (attempt === 1) return htmlResponse("nope", { status: 500 });
    return htmlResponse("<html><body>ok</body></html>");
  });

  const omnibox = $(document, "omnibox");
  omnibox.value = "https://example.com/";
  omnibox.dispatchEvent(new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(calls.length, 2, "fell through to a second mirror");
  const iframe = $(document, "views").querySelector(".view.active iframe");
  assert.match(iframe.getAttribute("srcdoc") || iframe.srcdoc || "", /ok/);
});

test("bookmarking adds the page to the new tab page", async () => {
  const { document } = await bootApp();
  const mode = $(document, "set-mode");
  mode.value = "simple";
  mode.dispatchEvent(new document.defaultView.Event("change"));
  stubFetch(() => htmlResponse("<html><head><title>Bookmarked page</title></head><body>hi</body></html>"));

  const omnibox = $(document, "omnibox");
  omnibox.value = "https://example.com/page";
  omnibox.dispatchEvent(new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  $(document, "btn-star").click();
  const saved = JSON.parse(localStorage.getItem("relay.bookmarks.v1"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].url, "https://example.com/page");
  assert.ok($(document, "btn-star").classList.contains("on"), "star lights up");

  $(document, "nav-home").click();
  const ntp = $(document, "views").querySelector(".ntp");
  assert.ok(ntp, "home returns to the new tab page");
  assert.match(ntp.textContent, /Bookmarks/, "bookmarks section appears");
});

test("the panic key hides the app and restores it", async () => {
  const { document, window } = await bootApp();
  const panic = $(document, "panic");
  assert.equal(panic.hidden, true);

  const press = () =>
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "`", bubbles: true }));

  press();
  assert.equal(panic.hidden, false, "panic screen shown");
  press();
  assert.equal(panic.hidden, true, "panic screen hidden again");
});

test("a search term is resolved through the configured engine", async () => {
  const { document } = await bootApp();
  const mode = $(document, "set-mode");
  mode.value = "simple";
  mode.dispatchEvent(new document.defaultView.Event("change"));

  const calls = stubFetch(() => htmlResponse("<html><body>results</body></html>"));
  const omnibox = $(document, "omnibox");
  omnibox.value = "tallest trees";
  omnibox.dispatchEvent(new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(calls.length >= 1);
  // The destination is percent-encoded into the mirror's `url` parameter,
  // so decode twice to recover the real search URL.
  const target = decodeURIComponent(decodeURIComponent(calls[0].url));
  assert.match(target, /duckduckgo\.com\/\?q=tallest trees/);
});
