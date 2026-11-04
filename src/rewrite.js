// Pine — HTML/CSS rewriting for Reader mode (the server-side fallback engine).
//
// Scramjet does the heavy lifting for full browsing. Reader mode exists for
// text-first reading, for browsers without service-worker support, and for
// networks where WebSockets are blocked. It strips scripts entirely and
// rewrites every URL back through /api/fetch so links, images and styles
// keep working.

const READER = (u) => `/api/fetch?mode=reader&url=${encodeURIComponent(u)}`;
const ASSET = (u) => `/api/fetch?mode=asset&url=${encodeURIComponent(u)}`;

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resolve(raw, base) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^(data|blob|javascript|vbscript|mailto|tel|sms|about):/i.test(trimmed))
    return trimmed.startsWith("data:") || /^(mailto|tel|sms):/i.test(trimmed) ? trimmed : null;
  try {
    const u = new URL(trimmed, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

function rewriteSrcset(value, base, proxify) {
  // Split into candidates without breaking data: URIs, which contain a
  // comma of their own. A candidate is "<url> [<descriptor>]"; data URIs
  // run until whitespace, so scan character by character.
  const candidates = [];
  let cur = "", i = 0;
  const s = String(value);
  while (i < s.length) {
    if (s[i] === ",") {
      // A comma ends the candidate UNLESS we're inside a data URI's
      // parameter section (data:<mediatype>,<data>): the first comma of a
      // candidate that starts with "data:" belongs to the URI.
      const trimmed = cur.trim();
      const inDataParams = /^data:[^,\s]*$/i.test(trimmed);
      if (!inDataParams) { candidates.push(cur); cur = ""; i++; continue; }
    }
    cur += s[i++];
  }
  if (cur.trim()) candidates.push(cur);
  return candidates
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      if (!parts[0]) return candidate;
      const resolved = resolve(parts[0], base);
      if (resolved && !resolved.startsWith("data:")) parts[0] = proxify(resolved);
      return parts.join(" ");
    })
    .join(", ");
}

export function rewriteCss(css, base) {
  let out = String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    const resolved = resolve(u, base);
    if (!resolved || resolved.startsWith("data:")) return m;
    return `url("${ASSET(resolved)}")`;
  });
  out = out.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    const resolved = resolve(u, base);
    if (!resolved) return m;
    return `@import "${ASSET(resolved)}"`;
  });
  return out;
}

const LINK_ATTRS = new Map([
  ["href", "auto"], ["src", "asset"], ["poster", "asset"], ["data", "asset"],
  ["cite", "page"], ["background", "asset"],
  ["data-src", "asset"], ["data-lazy-src", "asset"], ["data-original", "asset"],
  ["data-href", "page"], ["data-url", "page"],
]);

function rewriteTag(tag, base) {
  // `tag` is a full "<name ...>" string.
  const nameMatch = tag.match(/^<\s*([a-zA-Z][a-zA-Z0-9-]*)/);
  if (!nameMatch) return tag;
  const tagName = nameMatch[1].toLowerCase();

  return tag.replace(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'`>]+)/g,
    (m, attrRaw, eq, valueRaw) => {
      const attr = attrRaw.toLowerCase();
      // Strip inline event handlers (Reader is scriptless anyway).
      if (attr.startsWith("on")) return "";
      const quote = valueRaw[0] === '"' || valueRaw[0] === "'" ? valueRaw[0] : '"';
      const value = valueRaw[0] === '"' || valueRaw[0] === "'" ? valueRaw.slice(1, -1) : valueRaw;

      if (attr === "srcset" || attr === "imagesrcset" || attr === "data-srcset")
        return `${attrRaw}${eq}${quote}${escapeAttr(rewriteSrcset(value, base, ASSET))}${quote}`;
      if (attr === "style")
        return `${attrRaw}${eq}${quote}${escapeAttr(rewriteCss(value, base))}${quote}`;
      if (attr === "action" || attr === "formaction") {
        const resolved = resolve(value, base);
        return resolved ? `${attrRaw}${eq}"${READER(resolved)}"` : m;
      }
      if (attr === "ping") return ""; // no tracking beacons in reader mode

      const kind = LINK_ATTRS.get(attr);
      if (!kind) return m;
      // Script URLs in links would run in the Reader page's own context.
      if (/^\s*(javascript|vbscript):/i.test(value)) return `${attrRaw}${eq}"#"`;
      const resolved = resolve(value, base);
      if (!resolved || resolved.startsWith("data:") || /^(mailto|tel|sms):/i.test(resolved)) return m;
      // <a href> navigates; <link href> is an asset; stylesheet etc.
      let proxify = ASSET;
      if (tagName === "a" || tagName === "area" || kind === "page") proxify = READER;
      if (attr !== "href" && kind === "asset") proxify = ASSET;
      return `${attrRaw}${eq}"${escapeAttr(proxify(resolved))}"`;
    }
  );
}

function escapeAttr(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

const READER_STYLE = `
<style data-pine-reader>
  html{pine-reader:1}
  body{margin:0 auto!important;max-width:52rem;padding:4.75rem 1.25rem 4rem!important;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif!important;
    line-height:1.65;color:#1c2430;background:#fbfaf7}
  img,video{max-width:100%!important;height:auto}
  pre{overflow:auto} table{display:block;overflow-x:auto}
  #pine-reader-bar{position:fixed;inset:0 0 auto 0;z-index:2147483647;display:flex;gap:.6rem;
    align-items:center;padding:.55rem .9rem;background:#0e1f16;color:#d9f2e2;
    font:500 .82rem/1.3 system-ui,sans-serif;box-shadow:0 2px 14px rgba(0,0,0,.35)}
  #pine-reader-bar b{font-weight:700;letter-spacing:.02em}
  #pine-reader-bar a{color:#8fe6b0;text-decoration:none;border:1px solid #2c5c40;
    padding:.28rem .6rem;border-radius:999px;white-space:nowrap}
  #pine-reader-bar a:hover{background:#173626}
  #pine-reader-bar .u{opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  @media (prefers-color-scheme:dark){body{background:#10151b;color:#dde6ef}}
</style>`;

export function rewriteHtml(html, pageUrl) {
  let out = String(html);
  let base = pageUrl;

  // Honour <base href>, then remove the tag (all URLs become absolute anyway).
  const baseMatch = out.match(/<base[^>]+href\s*=\s*["']([^"']+)["'][^>]*>/i);
  if (baseMatch) {
    const resolved = resolve(baseMatch[1], pageUrl);
    if (resolved) base = resolved;
  }
  out = out.replace(/<base[^>]*>/gi, "");

  // Remove executable / embedded content. Reader mode is a reading view.
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  out = out.replace(/<script\b[^>]*\/?>/gi, "");
  out = out.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, "");
  out = out.replace(/<(iframe|object|embed|applet)\b[^>]*\/?>/gi, "");
  out = out.replace(/<\/?noscript[^>]*>/gi, ""); // keep no-script content, drop tags
  // Meta refresh → stay inside reader.
  out = out.replace(
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi,
    (tag) => {
      const m = tag.match(/content\s*=\s*["']\s*\d*\s*;?\s*url\s*=\s*([^"']+)["']/i);
      if (!m) return "";
      const resolved = resolve(m[1], base);
      return resolved ? `<meta http-equiv="refresh" content="0;url=${escapeAttr(READER(resolved))}">` : "";
    }
  );

  // <style> blocks.
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, open, css, close) => open + rewriteCss(css, base) + close);

  // All remaining tags' attributes. The pattern is quote-aware so a ">"
  // inside an attribute value (e.g. title="a > b") doesn't end the tag early.
  out = out.replace(/<[a-zA-Z](?:[^>"']|"[^"]*"|'[^']*')*>/g, (tag) => rewriteTag(tag, base));

  // Destination unwrapping for click-trackers (Bing/DuckDuckGo/Google).
  out = out.replace(/href="\/api\/fetch\?mode=reader&(?:amp;)?url=([^"]+)"/g, (m, enc) => {
    try {
      const u = new URL(decodeURIComponent(enc.replaceAll("&amp;", "&")));
      let dest = null;
      if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname.startsWith("/ck/")) dest = u.searchParams.get("u");
      else if (u.hostname.endsWith("duckduckgo.com") && u.pathname.startsWith("/l/")) dest = u.searchParams.get("uddg");
      else if (u.hostname.endsWith("google.com") && u.pathname === "/url") dest = u.searchParams.get("q") || u.searchParams.get("url");
      if (dest) {
        // Bing encodes as base64(url) with an "a1" prefix (url-safe, often unpadded).
        let d = dest;
        if (/^a1[A-Za-z0-9+/=_-]+$/.test(d)) {
          try {
            let b64 = d.slice(2).replaceAll("-", "+").replaceAll("_", "/");
            while (b64.length % 4) b64 += "=";
            d = Buffer.from(b64, "base64").toString("utf8");
          } catch { /* keep raw */ }
        }
        const final = resolve(d, pageUrl);
        if (final) return `href="${escapeAttr(READER(final))}"`;
      }
    } catch { /* leave untouched */ }
    return m;
  });

  // Inject reader chrome.
  const bar =
    `<div id="pine-reader-bar"><b>🌲 Pine Reader</b>` +
    `<span class="u">${escapeHtml(pageUrl)}</span>` +
    `<a href="/?goto=${encodeURIComponent(pageUrl)}" target="_top">Open in full browser</a>` +
    `<a href="${escapeAttr(pageUrl)}" target="_blank" rel="noreferrer">Original ↗</a></div>`;
  if (/<head\b[^>]*>/i.test(out)) out = out.replace(/<head\b[^>]*>/i, (m) => m + '<meta charset="utf-8">' + READER_STYLE);
  else out = '<meta charset="utf-8">' + READER_STYLE + out;
  if (/<body\b[^>]*>/i.test(out)) out = out.replace(/<body\b[^>]*>/i, (m) => m + bar);
  else out = bar + out;
  return out;
}

// Friendly error page shown by /api/fetch when a target can't be loaded.
export function readerErrorPage(message, targetUrl) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Couldn't load that page · Pine Reader</title>
<style>body{font-family:system-ui,sans-serif;background:#0c1510;color:#e4f3e9;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:34rem;padding:2rem;text-align:center}h1{font-size:1.4rem}p{opacity:.85;line-height:1.6;word-break:break-all}
a{color:#8fe6b0}.btn{display:inline-block;margin:.4rem;padding:.6rem 1.1rem;border:1px solid #2c5c40;border-radius:999px;text-decoration:none}</style>
<main><div style="font-size:2.6rem">🌲</div><h1>That page didn't load</h1>
<p>${escapeHtml(message)}</p><p>${escapeHtml(targetUrl || "")}</p>
${targetUrl ? `<a class="btn" href="/?goto=${encodeURIComponent(targetUrl)}" target="_top">Try the full browser</a>
<a class="btn" href="${escapeAttr(READER(targetUrl))}">Retry reader</a>` : ""}
<a class="btn" href="/" target="_top">Back to Pine</a></main>`;
}
