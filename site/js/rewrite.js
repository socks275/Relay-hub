/* Relay Hub — HTML rewriting for Simple (CORS) mode.
 *
 * Scramjet mode rewrites pages with a full JS/WASM rewriter running in the
 * service worker. Simple mode has no service worker, so instead we fetch the
 * HTML through a public CORS mirror and rewrite it as text:
 *
 *   1. drop anything that would block a framed, rewritten page
 *      (CSP meta tags, SRI hashes, frame-busting base targets);
 *   2. absolutise every URL, so subresources load from their real origin;
 *   3. inject <base> plus a small runtime that hands link clicks, form
 *      submits and fetch() calls back to Relay Hub's own tab machinery.
 *
 * Subresources are loaded *directly* from their origin rather than piped
 * through the mirror: <img>, <script>, <link> and <video> are not subject to
 * CORS, so this is both faster and kinder to the mirror. Only XHR/fetch,
 * which CORS does gate, goes back through the bridge.
 *
 * Pure string in, string out — no DOM — so it is unit-testable in Node.
 */

const URL_ATTRS = [
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "data-src",
  "data-href",
  "data-original",
  "data-url",
  "data-lazy-src",
];

const SKIP_PREFIX = /^(?:#|data:|blob:|javascript:|mailto:|tel:|sms:|about:|filesystem:)/i;

/* Attribute values, including unquoted and single-quoted forms. */
const ATTR_RE = new RegExp(
  `\\b(?:${URL_ATTRS.join("|")})\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'\`>]+))`,
  "gi",
);

const SRCSET_RE = /\b(srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`>]+))/gi;
const CSS_URL_RE = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;
const STYLE_BLOCK_RE = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;
const STYLE_ATTR_RE = /\b(style)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`>]+))/gi;
const CSP_META_RE =
  /<meta\s+[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*\/?>/gi;
const INTEGRITY_RE = /\s+integrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const TARGET_ATTR_RE = /\s+target\s*=\s*(?:"_parent"|"_top"|'_parent'|'_top'|_parent|_top)/gi;

export function absolutise(value, baseUrl) {
  const raw = String(value ?? "").trim();
  if (!raw || SKIP_PREFIX.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw; // already absolute
  if (raw.startsWith("//")) {
    try {
      return new URL(raw, baseUrl).href;
    } catch {
      return raw;
    }
  }
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return raw;
  }
}

function absolutiseSrcset(value, baseUrl) {
  return String(value)
    .split(",")
    .map((part) => {
      const [url, descriptor] = part.trim().split(/\s+/);
      if (!url) return part;
      return `${absolutise(url, baseUrl)}${descriptor ? ` ${descriptor}` : ""}`;
    })
    .join(", ");
}

/**
 * Rewrites `html` fetched from `url` so it can be rendered inside a
 * srcdoc iframe. `runtime` is the JS source injected into the page.
 */
export function rewriteHtml(html, url, { runtime = "", noScript = false } = {}) {
  let out = String(html ?? "");

  // 1. Remove page-level blocks.
  out = out.replace(CSP_META_RE, "");
  out = out.replace(INTEGRITY_RE, "");
  out = out.replace(TARGET_ATTR_RE, "");

  if (noScript) {
    out = out
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<script\b[^>]*\/?>/gi, "");
  }

  // 2. Absolutise URLs.
  out = out.replace(ATTR_RE, (match, dq, sq, bare) => {
    const value = dq ?? sq ?? bare ?? "";
    if (!value) return match;
    return swapValue(match, value, absolutise(value, url));
  });

  out = out.replace(SRCSET_RE, (match, _name, dq, sq, bare) => {
    const value = dq ?? sq ?? bare ?? "";
    if (!value) return match;
    return swapValue(match, value, absolutiseSrcset(value, url));
  });

  out = out.replace(STYLE_ATTR_RE, (match, _name, dq, sq, bare) => {
    const value = dq ?? sq ?? bare ?? "";
    if (!value || !/url\(/i.test(value)) return match;
    const next = value.replace(CSS_URL_RE, (m, q, u) => `url(${q}${absolutise(u, url)}${q})`);
    return swapValue(match, value, next);
  });

  out = out.replace(STYLE_BLOCK_RE, (_match, open, body, close) => {
    const next = body.replace(CSS_URL_RE, (m, q, u) => `url(${q}${absolutise(u, url)}${q})`);
    return `${open}${next}${close}`;
  });

  // 3. Inject <base> and the runtime.
  const head = [
    `<base href="${escapeAttr(url)}">`,
    '<meta name="referrer" content="no-referrer">',
    runtime ? `<script>${runtime}<\/script>` : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, (m) => `${m}\n${head}`);
  } else if (/<html\b[^>]*>/i.test(out)) {
    out = out.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>\n${head}\n</head>`);
  } else {
    out = `${head}\n${out}`;
  }

  return out;
}

/* Rebuilds `match` with `value` replaced by `next`, keeping whatever quotes
 * (or lack of them) the page used. Splicing by index avoids every escaping
 * hazard: no regex, no `$&`, no ambiguity when the value repeats. */
function swapValue(match, value, next) {
  if (!value || next === value) return match;
  const at = match.lastIndexOf(value);
  if (at === -1) return match;
  return match.slice(0, at) + next + match.slice(at + value.length);
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The script injected into every Simple-mode page. It runs inside a sandboxed
 * srcdoc iframe (opaque origin, no access to Relay Hub itself) and talks to
 * the host page over postMessage.
 */
export function runtimeScript() {
  return `(function () {
  var RELAY = "__relay";
  var seq = 0;
  var pending = {};

  function send(msg) {
    msg[RELAY] = true;
    try { parent.postMessage(msg, "*"); } catch (e) {}
  }
  function abs(u) {
    try { return new URL(u, document.baseURI).href; } catch (e) { return u; }
  }
  function isSkippable(href) {
    return !href || href.charAt(0) === "#" || /^(?:javascript|mailto|tel|data|blob|about):/i.test(href);
  }

  document.addEventListener("click", function (e) {
    var el = e.target;
    while (el && el !== document && (!el.getAttribute || !el.getAttribute("href"))) el = el.parentNode;
    if (!el || !el.getAttribute) return;
    var href = el.getAttribute("href");
    if (isSkippable(href)) return;
    e.preventDefault();
    e.stopPropagation();
    send({
      t: "nav",
      url: abs(href),
      newTab: e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1 || el.target === "_blank"
    });
  }, true);

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || !form.tagName || form.tagName.toLowerCase() !== "form") return;
    e.preventDefault();
    try {
      var action = abs(form.getAttribute("action") || document.baseURI);
      var method = (form.getAttribute("method") || "get").toLowerCase();
      var params = new URLSearchParams();
      new FormData(form).forEach(function (v, k) { params.append(k, v); });
      if (method === "post") {
        send({ t: "nav", url: action, post: params.toString() });
      } else {
        send({ t: "nav", url: action + (action.indexOf("?") === -1 ? "?" : "&") + params.toString() });
      }
    } catch (err) {}
  }, true);

  window.open = function (u) {
    if (u) send({ t: "open", url: abs(u) });
    return null;
  };

  window.addEventListener("message", function (e) {
    var d = e && e.data;
    if (!d || !d[RELAY] || d.t !== "fetchres") return;
    var resolve = pending[d.id];
    if (!resolve) return;
    delete pending[d.id];
    var body = null;
    if (d.body != null) {
      if (d.binary) {
        try {
          var bin = atob(d.body);
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          body = bytes;
        } catch (err) { body = null; }
      } else {
        body = d.body;
      }
    }
    try {
      resolve(new Response(body, { status: d.status || 200, statusText: d.statusText || "", headers: d.headers || {} }));
    } catch (err) {
      resolve(new Response(null, { status: 502 }));
    }
  });

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    url = abs(url);
    var opts = init || {};
    if (!opts.method && input && typeof input !== "string" && input.method) opts.method = input.method;
    var headers = {};
    try {
      new Headers(opts.headers || (input && input.headers) || {}).forEach(function (v, k) { headers[k] = v; });
    } catch (e) {}
    var body = opts.body != null ? opts.body : null;
    if (body && typeof body !== "string") {
      try { body = new URLSearchParams(body).toString(); } catch (e) { body = null; }
    }
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      pending[id] = resolve;
      send({ t: "fetch", id: id, url: url, method: (opts.method || "GET").toUpperCase(), headers: headers, body: body });
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new TypeError("Failed to fetch")); }
      }, 20000);
    });
  };

  var lastTitle = "";
  function reportTitle() {
    var t = document.title || "";
    if (t !== lastTitle) { lastTitle = t; send({ t: "title", title: t }); }
  }
  reportTitle();
  setInterval(reportTitle, 1000);
  send({ t: "ready" });
})();`;
}

export { SKIP_PREFIX, URL_ATTRS };
