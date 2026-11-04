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

export const PATHS = {
  sw: "/sw.js",
  prefix: "/lessons/",
  scramjet: "/scram/scramjet.js",
  wasm: "/scram/scramjet.wasm",
  utils: "/scram/scramjet-utils.js",
  controllerApi: "/controller/controller.api.js",
  inject: "/controller/controller.inject.js",
  wisp: "/wisp/",
  transports: {
    libcurl: "/clients/libcurl-client.js",
    epoxy: "/clients/epoxy-client.js",
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
  return `/api/fetch?mode=reader&url=${encodeURIComponent(url)}`;
}

// When a reader iframe navigates, its (same-origin) location carries the
// real destination in the ?url= parameter.
export function urlFromReaderLocation(href) {
  try {
    const u = new URL(href);
    if (u.pathname === "/api/fetch") return u.searchParams.get("url") || "";
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

export function defaultWispUrl(custom = "") {
  const c = String(custom || "").trim();
  if (c) {
    try {
      const u = new URL(c.match(/^wss?:\/\//) ? c : `wss://${c}`);
      if (!u.pathname.endsWith("/")) u.pathname += "/";
      return u.href;
    } catch { /* fall through to default */ }
  }
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${PATHS.wisp}`;
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
            const report = () => {
              try { cb.onTitle?.(w.document.title || "", ctx.client?.url?.href || ""); } catch { /* frame gone */ }
            };
            report();
            try {
              new w.MutationObserver(report).observe(w.document.documentElement, {
                childList: true, subtree: true, characterData: true,
              });
            } catch { /* titles just won't live-update */ }
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
    const url = this.wispUrl;
    return new Promise((resolve) => {
      let done = false;
      const finish = (ms) => { if (!done) { done = true; resolve(ms); } };
      try {
        const t0 = performance.now();
        const ws = new WebSocket(url);
        const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } finish(null); }, 6000);
        ws.onopen = () => { clearTimeout(timer); const ms = Math.round(performance.now() - t0); try { ws.close(); } catch { /* */ } finish(ms); };
        ws.onerror = () => { clearTimeout(timer); finish(null); };
      } catch {
        finish(null);
      }
    });
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
