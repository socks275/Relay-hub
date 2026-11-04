/* Relay Hub — Simple mode: the CORS fallback.
 *
 * Scramjet needs a reachable Wisp endpoint. On locked-down networks every
 * one of them may be blocked, so Simple mode fetches pages through public
 * CORS mirrors instead: ordinary HTTPS, no WebSocket, no WASM.
 *
 * It is deliberately the fallback, not the default. What you give up:
 * cookies/logins, WebSockets, streaming video and most single-page apps.
 * What you keep: text, images, links, search results and Wikipedia — which
 * is exactly what matters when everything else is blocked.
 */
import { CORS_PROXIES } from "./data.js";
import { rewriteHtml, runtimeScript } from "./rewrite.js";
import { corsMemory } from "./store.js";

const TEXTUAL = /^(?:text\/|application\/(?:json|javascript|xml|xhtml|atom|rss|x-www-form-urlencoded))/i;
const MAX_BYTES = 8 * 1024 * 1024;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

function orderedProxies() {
  const best = corsMemory.best();
  if (!best) return [...CORS_PROXIES];
  return [...CORS_PROXIES].sort((a, b) => (a.name === best ? -1 : b.name === best ? 1 : 0));
}

/**
 * Fetches `url` through the first CORS mirror that answers, in preference
 * order (whichever worked most recently goes first).
 */
/* A page's own headers can name hosts and cookies the mirror must not see,
 * and some (content-length, host) are simply wrong for this hop. */
const FORBIDDEN_HEADERS = /^(?:host|origin|referer|referrer|cookie|content-length|connection|keep-alive|transfer-encoding|upgrade)$/i;

function cleanHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!FORBIDDEN_HEADERS.test(k) && !String(k).startsWith("sec-")) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export async function corsFetch(url, { method = "GET", headers, body, timeout = 15000 } = {}) {
  const errors = [];
  const isBodyAllowed = !/^(?:GET|HEAD)$/i.test(method);
  for (const proxy of orderedProxies()) {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(proxy.build(url), {
        // The verb is an instruction to the mirror, not to the destination;
        // mirrors that only understand GET simply 405 and we move on.
        method,
        headers: cleanHeaders(headers),
        body: isBodyAllowed ? body || undefined : undefined,
        signal: controller.signal,
        credentials: "omit",
        redirect: "follow",
      });
      if (!res.ok) {
        errors.push(`${proxy.name}: HTTP ${res.status}`);
        continue;
      }
      const type = (res.headers.get("content-type") || "").split(";")[0].trim();
      const buffer = await res.arrayBuffer();
      if (!buffer.byteLength) {
        errors.push(`${proxy.name}: empty response`);
        continue;
      }
      if (buffer.byteLength > MAX_BYTES) {
        errors.push(`${proxy.name}: response too large`);
        continue;
      }
      const binary = type && !TEXTUAL.test(type);
      corsMemory.record(proxy.name, Math.round(performance.now() - started));
      return {
        proxy: proxy.name,
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries([...res.headers.entries()].filter(([k]) => !/^content-(encoding|length)|^set-cookie/i.test(k))),
        body: binary ? toBase64(buffer) : new TextDecoder().decode(buffer),
        binary,
        type,
      };
    } catch (err) {
      corsMemory.forget(proxy.name);
      errors.push(`${proxy.name}: ${err?.name === "AbortError" ? "timed out" : err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw Object.assign(
    new Error(`Every CORS mirror failed. ${errors.join(" · ")}`),
    { code: "NO_CORS", errors },
  );
}

/**
 * One Simple-mode tab: an iframe we fill with rewritten srcdoc, plus the
 * postMessage bridge that lets the page navigate and call fetch().
 */
export class SimpleFrame {
  constructor(iframe, cb = {}) {
    this.iframe = iframe;
    this.cb = cb;
    this.history = [];
    this.index = -1;
    this.loading = false;
    this._onMessage = this._onMessage.bind(this);
    window.addEventListener("message", this._onMessage);
  }

  destroy() {
    window.removeEventListener("message", this._onMessage);
  }

  _reply(payload) {
    try {
      this.iframe.contentWindow?.postMessage({ ...payload, __relay: true }, "*");
    } catch {
      /* frame gone */
    }
  }

  async _onMessage(event) {
    const data = event?.data;
    if (!data || !data.__relay) return;
    // srcdoc iframes are sandboxed, so event.origin is "null": identify the
    // sender by its window handle instead of trusting an origin string.
    if (event.source !== this.iframe.contentWindow) return;

    switch (data.t) {
      case "ready":
        this.cb.onLoad?.(this.url);
        break;
      case "title":
        this.cb.onTitle?.(data.title);
        break;
      case "nav":
        if (data.post) {
          // A POST has nowhere to go in Simple mode (mirrors only fetch by
          // URL), so downgrade to the target page and let the user retry.
          this.cb.onNav?.(data.url, { newTab: !!data.newTab });
        } else {
          this.cb.onNav?.(data.url, { newTab: !!data.newTab });
        }
        break;
      case "open":
        this.cb.onOpen?.(data.url);
        break;
      case "fetch":
        this._bridgeFetch(data);
        break;
      default:
        break;
    }
  }

  async _bridgeFetch({ id, url, method = "GET", headers = {}, body = null }) {
    try {
      const res = await corsFetch(url, { method, headers, body });
      this._reply({
        t: "fetchres",
        id,
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        body: res.body,
        binary: res.binary,
      });
    } catch {
      this._reply({ t: "fetchres", id, status: 502, statusText: "Bad Gateway", body: "" });
    }
  }

  get url() {
    return this.history[this.index] || "";
  }

  get canBack() {
    return this.index > 0;
  }

  get canForward() {
    return this.index >= 0 && this.index < this.history.length - 1;
  }

  /** Loads a URL, pushing it onto this tab's history. */
  async go(url, { noScript = false } = {}) {
    this.loading = true;
    this.cb.onLoading?.(url);
    try {
      const res = await corsFetch(url);
      const html = res.binary ? "" : res.body;
      const page = rewriteHtml(html, url, { runtime: runtimeScript(), noScript });
      this.noScript = noScript;
      this.iframe.srcdoc = page;
      if (this.history[this.index] !== url) {
        this.history = this.history.slice(0, this.index + 1);
        this.history.push(url);
        this.index = this.history.length - 1;
      }
      this.cb.onUrl?.(url);
      this.cb.onProxy?.(res.proxy);
      return res;
    } catch (err) {
      this.cb.onError?.(err);
      throw err;
    } finally {
      this.loading = false;
    }
  }

  back() {
    if (!this.canBack) return false;
    this.index -= 1;
    return this.go(this.history[this.index], { noScript: this.noScript });
  }

  forward() {
    if (!this.canForward) return false;
    this.index += 1;
    return this.go(this.history[this.index], { noScript: this.noScript });
  }

  reload() {
    const url = this.url;
    if (!url) return Promise.resolve();
    return this.go(url, { noScript: this.noScript });
  }
}
