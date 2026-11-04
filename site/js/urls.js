/* Relay Hub — URL handling.
 *
 * Pure functions only: no DOM, no globals touched at import time, so the
 * Node test suite can import this module directly.
 */

/* GitHub Pages serves a project site from a subpath (`/Relay-hub/`), a user
 * site from `/`, and forks from yet another name. Deriving the base from the
 * document means one build works everywhere, with no path configuration. */
export function resolveBase(docUrl) {
  const raw =
    docUrl ||
    (typeof document !== "undefined" && document.baseURI) ||
    (typeof location !== "undefined" && location.href) ||
    "http://localhost/";
  let base = "/";
  try {
    base = new URL(".", raw).pathname || "/";
  } catch {
    /* keep the root default */
  }
  if (!base.endsWith("/")) base += "/";
  return base;
}

export const APP_BASE = resolveBase();

export function appUrl(path = "") {
  return `${APP_BASE}${String(path).replace(/^\/+/, "")}`;
}

/** Parses a string into a URL, or null. Rejects anything but http(s). */
export function safeUrl(value, base) {
  if (!value) return null;
  try {
    const u = new URL(String(value).trim(), base || undefined);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

/** True when the input looks like a bare hostname rather than a search. */
export function looksLikeHost(input) {
  const s = String(input || "").trim();
  if (!s || /\s/.test(s)) return false;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(s)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/i.test(s)) return true;
  return (
    /^[a-z0-9-]+(\.[a-z0-9-]+)+(:|\/|\?|#|$)/i.test(s) &&
    /\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(s)
  );
}

export function isUrl(input) {
  return /^https?:\/\//i.test(String(input || "").trim());
}

/** `!yt lo-fi` → the YouTube search URL for "lo-fi". */
export function applyBang(input, bangs) {
  const m = String(input || "").match(/^!([a-z0-9]+)\s+(.*)$/i);
  if (!m) return "";
  const tpl = bangs?.[m[1].toLowerCase()];
  if (!tpl) return "";
  return tpl.replace("%s", encodeURIComponent(m[2].trim()));
}

/**
 * Turns whatever the user typed into an absolute URL:
 * a full URL, a bare host, a bang, or a search query.
 */
export function normaliseInput(raw, { search = "duckduckgo", engines = {}, bangs = {} } = {}) {
  const input = String(raw || "").trim();
  if (!input) return "";

  const banged = applyBang(input, bangs);
  if (banged) return banged;

  if (isUrl(input)) {
    const u = safeUrl(input);
    if (u) return u.href;
  }
  if (looksLikeHost(input)) {
    const u = safeUrl(`https://${input}`);
    if (u) return u.href;
  }
  const engine = engines[search] || engines.duckduckgo || { url: "https://duckduckgo.com/?q=%s" };
  return engine.url.replace("%s", encodeURIComponent(input));
}

/** Normalises a Wisp endpoint: adds wss://, guarantees a trailing slash. */
export function normaliseWispUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    // Only prepend wss:// when there is no scheme at all; "http://host"
    // must stay http so it can be rejected below.
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    const u = new URL(hasScheme ? raw : `wss://${raw}`);
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return "";
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u.href;
  } catch {
    return "";
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function faviconFor(url) {
  const host = hostOf(url);
  return host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : "";
}

/** `https://example.com/a/b?c` → `example.com/a/b` for tab labels. */
export function prettyUrl(url) {
  try {
    const u = new URL(url);
    const path = (u.pathname + u.search).replace(/\/$/, "");
    return u.hostname.replace(/^www\./, "") + (path === "/" ? "" : path);
  } catch {
    return String(url || "");
  }
}

export function sameUrl(a, b) {
  const strip = (v) => {
    try {
      const u = new URL(v);
      return `${u.origin}${u.pathname.replace(/\/$/, "")}${u.search}`.replace(/\?$/, "");
    } catch {
      return String(v || "");
    }
  };
  return strip(a) === strip(b);
}
