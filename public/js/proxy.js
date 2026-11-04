/* Pine — the proxy engine (client side).
 *
 * Scramjet (Mercury Workshop) does the browsing: a service worker under
 * /lessons/ intercepts each tab-iframe's traffic, the controller in this
 * page rewrites it with the Scramjet wasm rewriter, and a "transport"
 * (libcurl.js by default — real curl TLS fingerprints — or epoxy-tls)
 * tunnels it over a Wisp WebSocket to this server, which makes the real
 * TCP connections. Cookies are persisted per-browser in IndexedDB by the
 * controller, so logins survive reloads.
 *
 * Fallbacks, switchable per tab:
 *   reader  — server-side fetch + rewrite (/api/fetch), no JS, works
 *             anywhere a plain HTTPS request works.
 *   direct  — a plain iframe, for sites that allow framing.
 */
import { SEARCH_ENGINES, BANGS } from "./data.js";

/* The server edition is served from `/`; the GitHub Pages edition is served
 * from a project subpath such as `/Relay-hub/`. Derive that base from the
 * document at runtime so neither edition (nor forks under another repo
 * name) needs build-time path configuration. Guards keep this module safe
 * to import from Node unit tests, where there is no document. */
const DOC_URL =
  (typeof document !== "undefined" && document.baseURI) ||
  globalThis.location?.href ||
  "http://localhost/";
let APP_BASE = "/";
try {
  APP_BASE = new URL(".", DOC_URL).pathname || "/";
} catch { /* keep the root default */ }
if (!APP_BASE.endsWith("/")) APP_BASE += "/";
export { APP_BASE };

export function appUrl(path = "") {
  return `${APP_BASE}${String(path).replace(/^\/+/, "")}`;
}

export const STATIC_MODE = typeof window !== "undefined" && window.PINE_STATIC === true;

/* Third-party public Wisp endpoints used only by the static edition. The
 * pages build supplies its authoritative pool with window.PINE_WISP (its
 * normal output is the same default list). A custom server saved in
 * Settings always takes priority over this pool. */
const DEFAULT_PUBLIC_WISP_URLS = [
  "wss://wisp.webmc.fun/",
  "wss://wisp.freewisp.org/",
  "wss://wisp.mercurywork.shop/",
  "wss://wisp.terbiumon.top/wisp/",
  "wss://anura.pro/",
];
const CONFIGURED_WISP_URLS =
  typeof window !== "undefined" && Array.isArray(window.PINE_WISP)
    ? window.PINE_WISP.map((u) => String(u).trim()).filter(Boolean)
    : [];
export const PUBLIC_WISP_URLS = Object.freeze([...new Set(
  CONFIGURED_WISP_URLS.length ? CONFIGURED_WISP_URLS : DEFAULT_PUBLIC_WISP_URLS
)]);

export const PATHS = {
  sw: appUrl("sw.js"),
  prefix: appUrl("lessons/"),
  scramjet: appUrl("scram/scramjet.js"),
  wasm: appUrl("scram/scramjet.wasm"),
  utils: appUrl("scram/scramjet-utils.js"),
  controllerApi: appUrl("controller/controller.api.js"),
  inject: appUrl("controller/controller.inject.js"),
  wisp: appUrl("wisp/"),
  transports: {
    libcurl: appUrl("clients/libcurl-client.js"),
    epoxy: appUrl("clients/epoxy-client.js"),
  },
};

/* ------------------------------------------------------------------ */
/* URL handling                                                        */
/* ------------------------------------------------------------------ */

export function looksLikeHost(s) {
  if (!s || /\s/.test(s)) return false;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(s)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(s)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i.test(s) && /\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(s);
}

export function normaliseInput(raw, searchKey = "duckduckgo") {
  const input = String(raw || "").trim();
  if (!input) return "";
  // Bangs: "!yt lo-fi beats"
  const bang = input.match(/^!([a-z]+)\s+(.*)$/i);
  if (bang && BANGS[bang[1].toLowerCase()])
    return BANGS[bang[1].toLowerCase()].replace("%s", encodeURIComponent(bang[2].trim()));
  if (/^https?:\/\//i.test(input)) {
    try { return new URL(input).href; } catch { /* fall through to search */ }
  }
  if (looksLikeHost(input)) return "https://" + input;
  const engine = SEARCH_ENGINES[searchKey] || SEARCH_ENGINES.duckduckgo;
  return engine.url.replace("%s", encodeURIComponent(input));
}

export function readerUrl(url) {
  return `${appUrl("api/fetch")}?mode=reader&url=${encodeURIComponent(url)}`;
}

// When a reader iframe navigates, its (same-origin) location carries the
// real destination in the ?url= parameter.
export function urlFromReaderLocation(href) {
  try {
    const u = new URL(href);
    if (u.pathname.endsWith("/api/fetch")) return u.searchParams.get("url") || "";
  } catch { /* cross-origin or garbage */ }
  return "";
}

export function faviconFor(url) {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`;
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* Script / service-worker bootstrapping                               */
/* ------------------------------------------------------------------ */

const loadedScripts = new Map();
export function loadScript(src) {
  if (loadedScripts.has(src)) return loadedScripts.get(src);
  const p = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => { loadedScripts.delete(src); reject(new Error(`Failed to load ${src}`)); };
    document.head.appendChild(el);
  });
  loadedScripts.set(src, p);
  return p;
}

async function registerSw() {
  if (!("serviceWorker" in navigator))
    throw new Error("This browser doesn't support service workers, which the Scramjet engine needs. Try Reader mode.");
  const registration = await navigator.serviceWorker.register(PATHS.sw, {
    type: "classic",
    updateViaCache: "none",
  });
  await navigator.serviceWorker.ready;
  if (registration.active) return registration.active;
  const pending = registration.installing || registration.waiting;
  if (pending) {
    await new Promise((resolve) => {
      const done = () => resolve();
      pending.addEventListener("statechange", function onChange() {
        if (pending.state === "activated") { pending.removeEventListener("statechange", onChange); done(); }
      });
      navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
      setTimeout(done, 8000);
    });
  }
  return registration.active || navigator.serviceWorker.controller;
}

function pickCtor(globalObj, names) {
  if (!globalObj) return null;
  for (const n of names) if (typeof globalObj[n] === "function") return globalObj[n];
  if (typeof globalObj === "function") return globalObj;
  return null;
}

async function makeTransport(name, wispUrl) {
  if (name === "epoxy") {
    await loadScript(PATHS.transports.epoxy);
    const Ctor = pickCtor(window.EpoxyTransport, ["EpoxyClient", "default", "EpoxyTransport"]);
    if (!Ctor) throw new Error("epoxy transport didn't initialise.");
    return new Ctor({ wisp: wispUrl });
  }
  await loadScript(PATHS.transports.libcurl);
  const Ctor = pickCtor(window.LibcurlTransport, ["LibcurlClient", "default"]);
  if (!Ctor) throw new Error("libcurl transport didn't initialise.");
  return new Ctor({ wisp: wispUrl });
}

function normaliseWispUrl(value) {
  const c = String(value || "").trim();
  if (!c) return "";
  try {
    const u = new URL(c.match(/^wss?:\/\//) ? c : `wss://${c}`);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return "";
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u.href;
  } catch {
    return "";
  }
}

export function defaultWispUrl(custom = "") {
  const customUrl = normaliseWispUrl(custom);
  if (customUrl) return customUrl;
  if (STATIC_MODE) return normaliseWispUrl(PUBLIC_WISP_URLS[0]) || DEFAULT_PUBLIC_WISP_URLS[0];
  const loc = globalThis.location;
  return `${loc?.protocol === "https:" ? "wss:" : "ws:"}//${loc?.host || "localhost"}${PATHS.wisp}`;
}

function wispCandidates(custom = "") {
  const customUrl = normaliseWispUrl(custom);
  if (customUrl) return [customUrl];
  if (!STATIC_MODE) return [defaultWispUrl()];
  return [...new Set(PUBLIC_WISP_URLS.map(normaliseWispUrl).filter(Boolean))];
}

function probeWisp(url, timeoutMs = 3500) {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (ms) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* ignore */ }
      resolve(ms);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      const t0 = performance.now();
      ws = new WebSocket(url);
      ws.onopen = () => finish(Math.round(performance.now() - t0));
      ws.onerror = () => finish(null);
      ws.onclose = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

/* Pick the first public endpoint that answers from *this* browser/network.
 * School and workplace filters often block one Wisp host but not another.
 * Checks are sequential so a failed first choice costs at most the short
 * probe timeout and we do not open a burst of sockets on page load. */
async function chooseWispUrl(custom = "") {
  const candidates = wispCandidates(custom);
  if (!STATIC_MODE || normaliseWispUrl(custom) || candidates.length <= 1)
    return candidates[0] || defaultWispUrl(custom);
  for (const url of candidates) {
    if ((await probeWisp(url)) !== null) return url;
  }
  // Keep the first choice so the real transport can surface a useful error
  // (for example when a probe socket is dropped but a retry would work).
  return candidates[0];
}

/* ------------------------------------------------------------------ */
/* The engine                                                          */
/* ------------------------------------------------------------------ */

class ProxyEngine {
  constructor() {
    this.status = "idle"; // idle | loading | ready | error
    this.error = null;
    this.controller = null;
    this.transportName = "libcurl";
    this.wispUrl = defaultWispUrl();
    this.utils = false;
    this._initPromise = null;
    this._listeners = new Set();
  }

  onStatus(fn) { this._listeners.add(fn); fn(this.status, this); return () => this._listeners.delete(fn); }
  _setStatus(s, err) {
    this.status = s;
    this.error = err || null;
    for (const fn of this._listeners) { try { fn(s, this); } catch { /* listener bug */ } }
  }

  get ready() { return this.status === "ready" && !!this.controller; }

  async init({ transport = "libcurl", customWisp = "" } = {}) {
    this.transportName = transport;
    this.wispUrl = defaultWispUrl(customWisp);
    if (this.ready) return this.controller;
    if (this._initPromise) return this._initPromise;
    this._setStatus("loading");
    this._initPromise = (async () => {
      // In static mode this finds a reachable public Wisp host while the
      // service worker and bundles are loading. Server mode resolves at once.
      const wispChoice = chooseWispUrl(customWisp);
      const sw = await registerSw();
      if (!sw) throw new Error("Service worker didn't activate. Reload and try again.");
      await loadScript(PATHS.scramjet);
      await loadScript(PATHS.controllerApi);
      try {
        await loadScript(PATHS.utils);
        this.utils = !!window.$scramjetUtils;
      } catch {
        this.utils = false; // plugins are an enhancement, not a requirement
      }
      this.wispUrl = await wispChoice;
      const transportObj = await makeTransport(this.transportName, this.wispUrl);
      const { Controller, config } = window.$scramjetController;
      config.prefix = PATHS.prefix;
      config.scramjetPath = PATHS.scramjet;
      config.injectPath = PATHS.inject;
      config.wasmPath = PATHS.wasm;
      this.controller = new Controller({ serviceworker: sw, transport: transportObj });
      await Promise.race([
        this.controller.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Scramjet took too long to start.")), 25000)),
      ]);
      this._setStatus("ready");
      return this.controller;
    })().catch((err) => {
      this._initPromise = null;
      this._setStatus("error", err);
      throw err;
    });
    return this._initPromise;
  }

  // Hot-swap the transport (e.g. libcurl → epoxy, or onto a custom Wisp
  // server) without losing tabs, cookies or history.
  async setTransport(name, customWisp = "") {
    this.transportName = name;
    this.wispUrl = defaultWispUrl(customWisp);
    if (!this.controller) return this.init({ transport: name, customWisp });
    this.wispUrl = await chooseWispUrl(customWisp);
    const transportObj = await makeTransport(name, this.wispUrl);
    this.controller.setTransport(transportObj);
  }

  // Create a Scramjet frame bound to a tab's iframe.
  createFrame(iframe, cb = {}) {
    if (!this.controller) throw new Error("Proxy engine isn't ready yet.");
    const plugins = [];
    const utils = window.$scramjetUtils;
    if (this.utils && utils?.HttpCachePlugin) {
      try { plugins.push(new utils.HttpCachePlugin()); } catch { /* optional */ }
    }
    if (this.utils && utils?.UrlWatcherPlugin && cb.onUrl) {
      try { plugins.push(new utils.UrlWatcherPlugin((url) => cb.onUrl(url))); } catch { /* optional */ }
    }
    // Pine's own plugin: page titles for tab labels, load + error signals.
    const MP = utils?.ManagedPlugin || window.$scramjetController?.ManagedPlugin;
    if (MP) {
      class PinePlugin extends MP {
        constructor() { super("pine-frame", []); }
        install(frame) {
          super.install?.(frame);
          this.tap(frame.hooks.init.post, (ctx) => {
            if (!ctx.isTopLevel) return;
            const w = ctx.window;
            let lastTitle = null;
            const report = () => {
              try {
                const t = w.document.title || "";
                if (t !== lastTitle) {
                  lastTitle = t;
                  cb.onTitle?.(t, ctx.client?.url?.href || "");
                }
              } catch { /* frame gone */ }
            };
            report();
            // Change-only polling beats a MutationObserver over the whole
            // document (which fires constantly on ad/analytics-heavy sites).
            // One live interval per tab (plugin instances are per-frame);
            // it also self-clears once the frame's window is gone.
            clearInterval(this._titlePoll);
            const poll = (this._titlePoll = setInterval(() => {
              try {
                if (w.closed || !w.document) { clearInterval(poll); return; }
              } catch { clearInterval(poll); return; }
              report();
            }, 1200));
            try { w.addEventListener("load", () => { report(); cb.onLoad?.(); }); } catch { /* ignore */ }
            try { w.addEventListener("DOMContentLoaded", report); } catch { /* ignore */ }
          });
          try {
            this.tap(frame.hooks.error.request, (ctx) => {
              try { cb.onError?.(ctx.error, ctx.rawrequest); } catch { /* ignore */ }
            });
          } catch { /* error hook shape may differ; timeouts cover us */ }
        }
      }
      try { plugins.push(new PinePlugin()); } catch { /* optional */ }
    }
    return this.controller.createFrame(iframe, { plugins });
  }

  // Open+close a raw WebSocket to the Wisp endpoint and time it.
  pingWisp() {
    return probeWisp(this.wispUrl, 6000);
  }

  // Nuke proxy state (service worker, caches, Scramjet cookies DB).
  async reset() {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
      await Promise.all(regs.map((r) => r.unregister()));
    } catch { /* ignore */ }
    try {
      const keys = (await caches?.keys?.()) || [];
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch { /* ignore */ }
    for (const db of ["__scramjet_controller", "scramjet-bootstrap"]) {
      await new Promise((resolve) => {
        try {
          const req = indexedDB.deleteDatabase(db);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        } catch { resolve(); }
      });
    }
    this.controller = null;
    this._initPromise = null;
    this._setStatus("idle");
  }
}

export const proxy = new ProxyEngine();
