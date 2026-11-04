/* Relay Hub — the Scramjet engine.
 *
 * GitHub Pages can only serve static files, so the proxy itself runs in the
 * visitor's browser:
 *
 *   page  → service worker → Scramjet rewriter (WASM) → transport → Wisp
 *         → the real internet
 *
 * The transport is libcurl.js by default (real curl TLS fingerprints, which
 * is why these proxies survive fingerprint-based filters) or epoxy-tls.
 * Either way the bytes travel inside one encrypted WebSocket, so a network
 * filter sees a single connection to a Wisp endpoint rather than a list of
 * visited sites.
 *
 * Cookies and per-site storage live in IndexedDB in the visitor's browser.
 * Nobody — not GitHub, not the Wisp operator, not Relay Hub — keeps a copy.
 */
import { appUrl, normaliseWispUrl, hostOf } from "./urls.js";
import { DEFAULT_WISP_ENDPOINTS } from "./data.js";

export const PATHS = Object.freeze({
  sw: appUrl("sw.js"),
  prefix: appUrl("lessons/"),
  scramjet: appUrl("scram/scramjet.js"),
  wasm: appUrl("scram/scramjet.wasm"),
  utils: appUrl("scram/scramjet-utils.js"),
  controller: appUrl("controller/controller.api.js"),
  inject: appUrl("controller/controller.inject.js"),
  transports: {
    libcurl: appUrl("clients/libcurl-client.js"),
    epoxy: appUrl("clients/epoxy-client.js"),
  },
});

/* The build injects window.RELAY_WISP; the source default keeps local dev
 * (and a plain copy of site/) working without a build step. */
const CONFIGURED_WISP =
  (typeof window !== "undefined" && Array.isArray(window.RELAY_WISP) && window.RELAY_WISP) || [];
export const WISP_ENDPOINTS = Object.freeze(
  [...new Set(
    [...CONFIGURED_WISP, ...DEFAULT_WISP_ENDPOINTS].map(normaliseWispUrl).filter(Boolean),
  )],
);

const loadedScripts = new Map();
export function loadScript(src) {
  if (loadedScripts.has(src)) return loadedScripts.get(src);
  const p = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => {
      loadedScripts.delete(src);
      reject(new Error(`Could not load ${src}`));
    };
    document.head.appendChild(el);
  });
  loadedScripts.set(src, p);
  return p;
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
    if (!Ctor) throw new Error("The epoxy transport didn't initialise.");
    return new Ctor({ wisp: wispUrl });
  }
  await loadScript(PATHS.transports.libcurl);
  const Ctor = pickCtor(window.LibcurlTransport, ["LibcurlClient", "default"]);
  if (!Ctor) throw new Error("The libcurl transport didn't initialise.");
  return new Ctor({ wisp: wispUrl });
}

/* Opens a bare WebSocket to a candidate and times the handshake. */
export function probeWisp(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (ms) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
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

/** Races every endpoint in the pool and returns the fastest that answers. */
export async function raceWispPool(endpoints = WISP_ENDPOINTS, { timeout = 6000 } = {}) {
  const candidates = [...new Set(endpoints.map(normaliseWispUrl).filter(Boolean))];
  if (!candidates.length) throw new Error("No Wisp endpoints configured.");

  const results = await Promise.all(
    candidates.map(async (url) => ({ url, ms: await probeWisp(url, timeout) })),
  );
  const reachable = results.filter((r) => r.ms !== null).sort((a, b) => a.ms - b.ms);
  if (!reachable.length) {
    throw Object.assign(
      new Error(
        `None of the ${candidates.length} Wisp endpoints answered from this network.`,
      ),
      { code: "NO_WISP", tried: candidates },
    );
  }
  return reachable[0];
}

async function registerSw() {
  if (!("serviceWorker" in navigator))
    throw new Error(
      "This browser doesn't support service workers, which the Scramjet engine needs. Switch Engine to Simple in Settings.",
    );
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
        if (pending.state === "activated") {
          pending.removeEventListener("statechange", onChange);
          done();
        }
      });
      navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
      setTimeout(done, 8000);
    });
  }
  return registration.active || navigator.serviceWorker.controller;
}

class ScramjetEngine {
  constructor() {
    this.status = "idle"; // idle | loading | ready | error
    this.error = null;
    this.controller = null;
    this.transport = "libcurl";
    this.wispUrl = "";
    this.wispLatency = null;
    this.utils = null;
    this._promise = null;
    this._listeners = new Set();
  }

  get ready() {
    return this.status === "ready" && !!this.controller;
  }

  onStatus(fn) {
    this._listeners.add(fn);
    fn(this.status, this);
    return () => this._listeners.delete(fn);
  }

  _emit(status, error = null) {
    this.status = status;
    this.error = error;
    for (const fn of [...this._listeners]) {
      try {
        fn(status, this);
      } catch {
        /* a broken listener must not break the engine */
      }
    }
  }

  candidates(custom = "") {
    const customUrl = normaliseWispUrl(custom);
    if (customUrl) return [customUrl];
    return WISP_ENDPOINTS.length ? [...WISP_ENDPOINTS] : [];
  }

  async init({ transport = "libcurl", wisp = "" } = {}) {
    this.transport = transport;
    if (this.ready) return this.controller;
    if (this._promise) return this._promise;
    this._emit("loading");

    this._promise = (async () => {
      // Start the endpoint race before the bundles finish downloading: on a
      // warm cache the two finish together instead of back to back.
      const wispRace = raceWispPool(this.candidates(wisp)).catch((err) => {
        throw err;
      });

      const sw = await registerSw();
      if (!sw) throw new Error("The service worker didn't activate. Reload and try again.");

      await loadScript(PATHS.scramjet);
      await loadScript(PATHS.controller);
      try {
        await loadScript(PATHS.utils);
        this.utils = window.$scramjetUtils || null;
      } catch {
        this.utils = null; // plugins are an enhancement, never a requirement
      }

      const chosen = await wispRace;
      this.wispUrl = chosen.url;
      this.wispLatency = chosen.ms;

      const transportObj = await makeTransport(transport, this.wispUrl);
      const { Controller, config } = window.$scramjetController;
      config.prefix = PATHS.prefix;
      config.scramjetPath = PATHS.scramjet;
      config.injectPath = PATHS.inject;
      config.wasmPath = PATHS.wasm;

      this.controller = new Controller({ serviceworker: sw, transport: transportObj });
      await Promise.race([
        this.controller.wait(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Scramjet took too long to start.")), 25000),
        ),
      ]);
      this._emit("ready");
      return this.controller;
    })().catch((err) => {
      this._promise = null;
      this._emit("error", err);
      throw err;
    });

    return this._promise;
  }

  /** Swaps transport/endpoint live, keeping tabs, cookies and history. */
  async reconnect({ transport = this.transport, wisp = "" } = {}) {
    this.transport = transport;
    if (!this.controller) return this.init({ transport, wisp });
    const chosen = await raceWispPool(this.candidates(wisp));
    this.wispUrl = chosen.url;
    this.wispLatency = chosen.ms;
    this.controller.setTransport(await makeTransport(transport, this.wispUrl));
    return this.controller;
  }

  createFrame(iframe, cb = {}) {
    if (!this.controller) throw new Error("The proxy engine isn't ready yet.");
    const plugins = [];
    const utils = this.utils;

    if (utils?.HttpCachePlugin) {
      try {
        plugins.push(new utils.HttpCachePlugin());
      } catch {
        /* optional */
      }
    }
    if (utils?.UrlWatcherPlugin && cb.onUrl) {
      try {
        plugins.push(new utils.UrlWatcherPlugin((url) => cb.onUrl?.(url)));
      } catch {
        /* optional */
      }
    }
    if (utils?.CatchEscapedLinksPlugin && cb.onEscaped) {
      try {
        plugins.push(
          new utils.CatchEscapedLinksPlugin((url) => cb.onEscaped?.(url)),
        );
      } catch {
        /* optional */
      }
    }

    const ManagedPlugin = utils?.ManagedPlugin || window.$scramjetController?.ManagedPlugin;
    if (ManagedPlugin) {
      class RelayFramePlugin extends ManagedPlugin {
        constructor() {
          super("relay-frame", []);
        }
        install(frame) {
          super.install?.(frame);

          this.tap(frame.hooks.init.post, (ctx) => {
            if (!ctx.isTopLevel) return;
            const win = ctx.window;
            let last = null;
            const report = () => {
              try {
                const title = win.document.title || "";
                if (title !== last) {
                  last = title;
                  cb.onTitle?.(title);
                }
              } catch {
                /* frame went away */
              }
            };
            report();
            // Polling beats a document-wide MutationObserver here: ad and
            // analytics churn fires that constantly on real sites.
            const poll = setInterval(() => {
              try {
                if (win.closed || !win.document) {
                  clearInterval(poll);
                  return;
                }
              } catch {
                clearInterval(poll);
                return;
              }
              report();
            }, 1200);
            try {
              win.addEventListener("load", () => {
                report();
                cb.onLoad?.();
              });
            } catch {
              /* ignore */
            }
            try {
              win.addEventListener("DOMContentLoaded", report);
            } catch {
              /* ignore */
            }
          });

          try {
            this.tap(frame.hooks.error.request, (ctx) => {
              try {
                cb.onError?.(ctx.error, ctx.rawrequest);
              } catch {
                /* ignore */
              }
            });
          } catch {
            /* hook shape may differ between versions; timeouts cover us */
          }
        }
      }
      try {
        plugins.push(new RelayFramePlugin());
      } catch {
        /* optional */
      }
    }

    return this.controller.createFrame(iframe, { plugins });
  }

  destroyFrame(frame) {
    try {
      const idx = this.controller?.frames?.indexOf(frame) ?? -1;
      if (idx >= 0) this.controller.frames.splice(idx, 1);
    } catch {
      /* ignore */
    }
  }

  async ping() {
    if (!this.wispUrl) return null;
    return probeWisp(this.wispUrl, 6000);
  }

  /** Wipes service worker, caches and Scramjet's cookie database. */
  async reset() {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
      await Promise.all(regs.map((r) => r.unregister()));
    } catch {
      /* ignore */
    }
    try {
      const keys = (await caches?.keys?.()) || [];
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      /* ignore */
    }
    for (const db of ["__scramjet_controller", "scramjet-bootstrap"]) {
      await new Promise((resolve) => {
        try {
          const req = indexedDB.deleteDatabase(db);
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        } catch {
          resolve();
        }
      });
    }
    this.controller = null;
    this._promise = null;
    this._emit("idle");
  }
}

export const engine = new ScramjetEngine();
export { hostOf };
