'use strict';

/*
 * HTML rewriter.
 *
 * Design notes — these are the things that make a rewriting proxy actually
 * survive contact with real sites:
 *
 *  - We split the document into "raw islands" (<script>, <style>, comments,
 *    <textarea>, <title>, …) so we never mangle JavaScript string literals or
 *    CSS text while rewriting attributes.
 *  - Every URL-bearing attribute is rewritten, including the long tail
 *    (xlink:href, formaction, data-*, poster, srcset, imagesrcset, ping).
 *  - A tiny bootstrap script is injected *first* in <head> which patches
 *    fetch/XHR/WebSocket/history/pushState/location, so client-side apps that
 *    build URLs at runtime still route through the proxy.
 *  - CSP / SRI / referrer-policy / frame-busting are neutralised, because they
 *    would otherwise block every rewritten resource.
 *  - `<base>` is honoured (so relative URLs resolve like the browser would)
 *    then removed.
 */

const crypto = require('crypto');
const {
  rewriteUrl,
  proxifyUrl,
  b64url,
  PREFIX,
  SCHEMES_SKIP,
} = require('../url');

const MAX_HTML = 24 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/*  Escaping                                                          */
/* ------------------------------------------------------------------ */

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  '#39': "'",
  '#x27': "'",
  '#34': '"',
  '#x22': '"',
  '#38': '&',
  '#x26': '&',
  '#60': '<',
  '#x3c': '<',
  '#62': '>',
  '#x3e': '>',
};

function decodeEntities(str) {
  return String(str).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    const lower = body.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ENTITIES, lower)) return ENTITIES[lower];
    if (lower.startsWith('#')) {
      const num = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      if (Number.isFinite(num) && num >= 0 && num <= 0x10ffff) {
        try {
          return String.fromCodePoint(num);
        } catch {
          return m;
        }
      }
    }
    return m;
  });
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape a value for a JS string literal inside an inline <script>. */
function jsString(value) {
  return JSON.stringify(String(value))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/* ------------------------------------------------------------------ */
/*  Document structure helpers                                        */
/* ------------------------------------------------------------------ */

const RAW_TAGS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
  'noscript',
  'template',
]);

/**
 * Split HTML into [{raw:boolean, tag, text}] where `raw` chunks are elements
 * whose inner text must not be touched (except we do handle style/script).
 */
function splitIslands(html) {
  const parts = [];
  const re = /<!--[\s\S]*?-->|<(script|style|textarea|title|xmp|noembed|noframes|plaintext|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
  let last = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m.index > last) parts.push({ raw: false, text: html.slice(last, m.index) });
    if (m[1]) {
      parts.push({ raw: true, tag: m[1].toLowerCase(), text: m[0] });
    } else {
      parts.push({ raw: true, tag: '!--', text: m[0] });
    }
    last = re.lastIndex;
  }
  if (last < html.length) parts.push({ raw: false, text: html.slice(last) });
  return parts;
}

/** Apply `fn` to the inner content of a `<tag>…</tag>` block. */
function mapInner(block, tag, fn) {
  const re = new RegExp('^(<' + tag + '\\b[^>]*>)([\\s\\S]*?)(</' + tag + '\\s*>)$', 'i');
  const m = re.exec(block);
  if (!m) return block;
  return m[1] + fn(m[2]) + m[3];
}

/* ------------------------------------------------------------------ */
/*  CSS rewriting                                                     */
/* ------------------------------------------------------------------ */

/** Rewrite url(...) and @import inside a CSS string. */
function rewriteCss(css, base, opts = {}) {
  void opts;
  let out = String(css);

  out = out.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]+?))\s*\)/gi, (m, dq, sq, uq) => {
    const raw = dq !== undefined ? dq : sq !== undefined ? sq : uq;
    if (raw === undefined) return m;
    const value = decodeEntities(raw).trim();
    if (!value) return m;
    if (value.startsWith('data:') || value.startsWith('#') || /^var\(/i.test(value)) return m;
    const mapped = rewriteUrl(value, { base, mode: 'raw' });
    if (mapped === value) return m;
    return 'url("' + mapped.replace(/"/g, '%22') + '")';
  });

  out = out.replace(/@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^'")\s;]+))/gi, (m, dq, sq, uq) => {
    const raw = dq !== undefined ? dq : sq !== undefined ? sq : uq;
    if (!raw) return m;
    const value = decodeEntities(raw).trim();
    if (!value || /^data:/i.test(value)) return m;
    const mapped = rewriteUrl(value, { base, mode: 'raw' });
    return '@import url("' + mapped.replace(/"/g, '%22') + '")';
  });

  // Source maps would point at the origin server and 404 anyway.
  out = out.replace(/\/\*[#@]\s*sourceMappingURL=[^*]*\*\//g, '');

  if (opts.reader) return sanitizeCss(out);
  return out;
}

/** Inline-style attribute value: keep it compact, avoid raw parens/quotes. */
function rewriteInlineStyle(value, base) {
  const mapped = rewriteCss(value, base, {});
  return mapped.replace(/(["'])/g, '%22');
}

/* ------------------------------------------------------------------ */
/*  Attribute-level rewriting                                          */
/* ------------------------------------------------------------------ */

const URL_ATTRS = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'data',
  'background',
  'cite',
  'longdesc',
  'usemap',
  'manifest',
  'codebase',
  'archive',
  'xlink:href',
  'data-src',
  'data-href',
  'data-url',
  'data-link',
  'data-bg',
  'data-background',
  'data-image',
  'data-thumb',
  'data-poster',
  'data-original',
  'data-lazy-src',
]);

const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset', 'data-srcset']);
/**
 * Rewrite the attributes inside one HTML tag string (which begins with `<`).
 * `ctx` = { base, reader, nonce, target }
 */
function rewriteTag(tag, ctx) {
  const base = ctx.base;
  const reader = !!ctx.reader;

  // 1. Drop dangerous / proxy-breaking attributes wholesale.
  let out = tag.replace(
    /\s(?:integrity|crossorigin|nonce|referrerpolicy)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    ''
  );
  out = out.replace(/\s(?:integrity|crossorigin|nonce|referrerpolicy)(?=[\s>/])/gi, '');

  // 2. Attribute-by-attribute pass.
  out = out.replace(
    /(\s)([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/g,
    (m, space, name, eq, rawValue) => {
      const lname = name.toLowerCase();
      const quote = rawValue[0] === '"' || rawValue[0] === "'" ? rawValue[0] : '"';
      const inner = rawValue[0] === '"' || rawValue[0] === "'" ? rawValue.slice(1, -1) : rawValue;
      const value = decodeEntities(inner);

      if (URL_ATTRS.has(lname)) {
        const isFormAction = lname === 'action' || lname === 'formaction';
        let mapped;
        if (isFormAction) {
          const trimmed = value.trim();
          mapped = trimmed === '' ? PREFIX.form + '/' + b64url(base) : rewriteUrl(trimmed, { base, mode: 'form' });
        } else if (lname === 'usemap') {
          mapped = value; // fragment-only map reference
        } else if (lname === 'data' && ctx.tagName !== 'object') {
          mapped = rewriteUrl(value, { base, mode: 'raw' });
        } else {
          mapped = rewriteUrl(value, { base, mode: 'link', reader });
        }
        return space + name + eq + quote + escapeAttr(mapped) + quote;
      }

      if (SRCSET_ATTRS.has(lname)) {
        const mapped = rewriteSrcset(value, base, reader);
        return space + name + eq + quote + escapeAttr(mapped) + quote;
      }

      if (lname === 'style') {
        return space + name + eq + quote + escapeAttrSafe(rewriteInlineStyle(value, base), quote) + quote;
      }

      if (lname === 'ping') {
        return space + name + eq + quote + escapeAttr(rewritePing(value, base)) + quote;
      }

      if (lname === 'srcdoc') {
        // Nested document: rewrite it too (one level is plenty).
        let inner2 = value;
        try {
          inner2 = rewriteHtmlFragment(inner2, base, ctx);
        } catch {
          /* keep as-is */
        }
        return space + name + eq + quote + escapeAttr(inner2) + quote;
      }

      if (lname === 'target') {
        const v = value.trim().toLowerCase();
        if (v === '_blank' || v === '_new' || v === '_top' || v === '_parent') {
          // Keep everything inside the viewer.
          return '';
        }
        return space + name + eq + quote + escapeAttrSafe(value, quote) + quote;
      }

      if (lname === 'meta' || lname === 'http-equiv') return m;

      return m;
    }
  );

  // 3. Reader mode: strip inline event handlers.
  if (reader) {
    out = out.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    out = out.replace(/\son[a-z]+(?=[\s>/])/gi, '');
  }

  return out;
}

function escapeAttrSafe(value, quote) {
  if (quote === "'") return String(value).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function rewritePing(value, base) {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((u) => rewriteUrl(u, { base, mode: 'raw' }))
    .join(' ');
}

function rewriteSrcset(value, base, reader) {
  if (!value) return value;
  return String(value)
    .split(',')
    .map((candidate) => {
      const t = candidate.trim();
      if (!t) return '';
      const bits = t.split(/\s+/);
      const url = bits.shift();
      if (!url) return '';
      return [rewriteUrl(url, { base, mode: 'raw' }), ...bits].join(' ');
    })
    .filter(Boolean)
    .join(', ');
}

/* ------------------------------------------------------------------ */
/*  Reader-mode CSS sanitising                                        */
/* ------------------------------------------------------------------ */

function sanitizeCss(css) {
  // Reader mode should look like a document, not the publisher's ad layout.
  return (
    String(css)
      .replace(/@import[^;]+;/gi, '')
      .replace(/#[a-z0-9_-]*\d[a-z0-9_-]*\s*\{[^}]*position\s*:\s*fixed[^}]*\}/gi, '')
      .trim()
  );
}

/* ------------------------------------------------------------------ */
/*  Injected client runtime                                           */
/* ------------------------------------------------------------------ */

/**
 * The bootstrap that runs *inside* every proxied page. It:
 *   - routes fetch/XHR/WebSocket/beacon/EventSource through the proxy
 *   - patches history.pushState/replaceState so the address bar follows
 *   - rewrites links clicked at runtime (SPAs build them client-side)
 *   - reports navigation back to the Relay chrome via postMessage
 *   - bridges document.cookie to the server-side jar (optional popup)
 */
function clientRuntime(ctx) {
  const nonce = ctx.nonce || '';
  const target = ctx.target || '';
  const reader = !!ctx.reader;
  return (
    '<script data-relay-runtime="1">(function(){' +
    'if(window.__relayInstalled)return;window.__relayInstalled=1;' +
    'var N=' + jsString(nonce) + ',T=' + jsString(target) + ',R=' + (reader ? '1' : '0') + ';' +
    'var P="/fetch?url=",RAW="/raw?url=",PP="/p/";' +
    'function abs(u,b){try{return new URL(u,b||location.href).href}catch(e){return null}}' +
    'function isOwn(u){return u&&(u.indexOf(location.origin+"/p/")===0||u.indexOf(location.origin+"/fetch")===0||u.indexOf(location.origin+"/raw")===0)}' +
    // Map a runtime-built URL onto the proxy.
    'function map(u,kind){try{' +
    'if(!u)return u;if(u.charAt(0)==="#")return u;' +
    'if(/^(javascript|mailto|tel|sms|data|blob|about|chrome|magnet|whatsapp|intent|market|file):/i.test(u))return u;' +
    'var a=abs(u);if(!a)return u;if(isOwn(a))return a;' +
    'if(a.indexOf("ws://")===0||a.indexOf("wss://")===0)return"/ws?url="+encodeURIComponent(a);' +
    'if(kind==="raw")return RAW+encodeURIComponent(a);' +
    'return P+encodeURIComponent(a)+(R?"&m=1":"");' +
    '}catch(e){return u}}' +
    'window.__relayMap=map;' +
    // fetch
    'if(window.fetch){var F=window.fetch;window.fetch=function(i,o){try{' +
    'if(typeof i==="string"||i instanceof URL){i=map(String(i),"raw")}' +
    'else if(i&&i.url){var u=map(i.url,"raw");if(u!==i.url){i=new Request(u,i)}}' +
    '}catch(e){}return F.call(this,i,o)}}' +
    // XHR
    'if(window.XMLHttpRequest){var X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=map(String(u),"raw")}catch(e){}return X.apply(this,arguments)}}' +
    // WebSocket
    'if(window.WebSocket){var W=window.WebSocket;var Px=function(u,p){try{u=map(String(u),"ws")}catch(e){}return p?new W(u,p):new W(u)};' +
    'Px.prototype=W.prototype;["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(function(k){Px[k]=W[k]});window.WebSocket=Px}' +
    // sendBeacon
    'if(navigator.sendBeacon){var B=navigator.sendBeacon;navigator.sendBeacon=function(u,d){try{u=map(String(u),"raw")}catch(e){}return B.call(navigator,u,d)}}' +
    // EventSource
    'if(window.EventSource){var E=window.EventSource;var Px2=function(u,c){try{u=map(String(u),"raw")}catch(e){}return new E(u,c)};Px2.prototype=E.prototype;window.EventSource=Px2}' +
    // history
    'function patchH(n){var f=history[n];if(!f)return;history[n]=function(s,t,u){' +
    'try{if(u&&!isOwn(abs(u))){return f.call(history,s,t,P+encodeURIComponent(abs(u))+(R?"&m=1":""))}}catch(e){}' +
    'var r=f.apply(history,arguments);try{report()}catch(e){}return r}}' +
    'patchH("pushState");patchH("replaceState");' +
    // runtime link interception (capture phase so page handlers don't win)
    'if(!R){document.addEventListener("click",function(e){' +
    'var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;' +
    'var h=a.getAttribute("href");if(!h||h.charAt(0)==="#"||/^javascript:/i.test(h))return;' +
    'var m=map(h);if(m!==h){try{a.setAttribute("href",m)}catch(x){}}' +
    '},true)}' +
    // form submissions built client-side
    'document.addEventListener("submit",function(e){' +
    'var f=e.target;if(!f||!f.getAttribute||!f.getAttribute("action"))return;' +
    'try{var a=abs(f.getAttribute("action"));if(a&&!isOwn(a))f.setAttribute("action","/form/"+btoa(a).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,""))}catch(x){}' +
    '},true);' +
    // navigation reporting
    'function report(){try{parent.postMessage({__relay:1,type:"nav",nonce:N,target:T,proxy:location.href,title:document.title||"",scroll:window.scrollY||0},"*")}catch(e){}}' +
    'window.addEventListener("load",report);window.addEventListener("popstate",report);' +
    'setTimeout(report,300);setTimeout(report,1200);setTimeout(report,3000);' +
    // commands from the chrome
    'window.addEventListener("message",function(e){var d=e.data||{};if(!d.__relayCmd)return;try{' +
    'if(d.cmd==="back")history.back();else if(d.cmd==="forward")history.forward();' +
    'else if(d.cmd==="reload")location.reload();' +
    'else if(d.cmd==="scroll"&&typeof d.y==="number")window.scrollTo(0,d.y);' +
    'else if(d.cmd==="find"&&d.q){if(window.find)window.find(d.q)}' +
    '}catch(x){}});' +
    // expose the current target for the parent
    'window.__relayTarget=T;' +
    '})();</script>'
  );
}

/* ------------------------------------------------------------------ */
/*  Main rewrite                                                      */
/* ------------------------------------------------------------------ */

/**
 * Rewrite a full HTML document.
 * @param {string} html
 * @param {{url:string, reader?:boolean, nonce?:string, frame?:boolean}} opts
 */
function rewriteHtml(html, opts) {
  const targetUrl = opts.url;
  const reader = !!opts.reader;
  const nonce = opts.nonce || '';

  if (html.length > MAX_HTML) {
    // Refuse to buffer monsters; caller should have streamed it.
    return html;
  }

  // Resolve <base href> like a browser would, then remove the tag.
  let base = targetUrl;
  const baseTag = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  if (baseTag) {
    const raw = baseTag[1] !== undefined ? baseTag[1] : baseTag[2] !== undefined ? baseTag[2] : baseTag[3];
    try {
      base = new URL(decodeEntities(raw), targetUrl).href;
    } catch {
      base = targetUrl;
    }
  }

  let work = html;

  // ---- Pre-pass: remove things that would break the proxy ------------
  work = work.replace(/<base\b[^>]*>/gi, '');
  work = work.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*content-security-policy["']?[^>]*>/gi, '');
  work = work.replace(/<meta\b[^>]*name\s*=\s*["']?\s*referrer["']?[^>]*>/gi, '');
  work = work.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*x-frame-options["']?[^>]*>/gi, '');
  if (reader) {
    work = work.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh["']?[^>]*>/gi, '');
  }
  // Frame busters that only work because we're framed.
  work = work.replace(/<meta\b[^>]*name\s*=\s*["']?apple-itunes-app["']?[^>]*>/gi, '');

  const ctx = { base, target: targetUrl, reader, nonce };

  // ---- Island pass ---------------------------------------------------
  const parts = splitIslands(work);
  const outParts = parts.map((part) => {
    if (!part.raw) {
      return rewriteMarkupChunk(part.text, ctx);
    }
    if (part.tag === '!--') return part.text;
    if (part.tag === 'style') {
      return mapInner(part.text, 'style', (inner) => rewriteCss(inner, base, { reader }));
    }
    if (part.tag === 'script') {
      if (reader) return '';
      return rewriteScriptBlock(part.text, ctx);
    }
    if (part.tag === 'template') {
      return mapInner(part.text, 'template', (inner) => rewriteHtmlFragment(inner, base, ctx));
    }
    if (part.tag === 'textarea' || part.tag === 'title' || part.tag === 'xmp') {
      return part.text;
    }
    if (part.tag === 'noscript' || part.tag === 'noembed' || part.tag === 'noframes') {
      return rewriteHtmlFragment(part.text, base, ctx, part.tag);
    }
    return part.text;
  });

  let out = outParts.join('');

  // ---- Meta refresh ------------------------------------------------
  if (!reader) {
    out = out.replace(
      /(<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh["']?[^>]*content\s*=\s*["'])([^"']*)(["'])/gi,
      (m, a, content, b) => {
        const rewritten = decodeEntities(content).replace(
          /(url\s*=\s*["']?)([^"';\s]+)/gi,
          (mm, pre, u) => pre + rewriteUrl(u, { base, mode: 'link', reader })
        );
        return a + rewritten + b;
      }
    );
  }

  // ---- Head injections ---------------------------------------------
  const headBits =
    '<meta name="referrer" content="unsafe-url">' +
    '<meta name="relay-target" content="' + escapeAttr(targetUrl) + '">' +
    clientRuntime(ctx) +
    (reader ? readerStyles() : '');

  if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, (m) => m + headBits);
  } else if (/<html\b[^>]*>/i.test(out)) {
    out = out.replace(/<html\b[^>]*>/i, (m) => m + '<head>' + headBits + '</head>');
  } else {
    out = headBits + out;
  }

  // ---- Make the viewport sane inside our frame ----------------------
  if (!/<meta\b[^>]*name\s*=\s*["']?viewport/i.test(out)) {
    out = out.replace(/<\/head\s*>/i, '<meta name="viewport" content="width=device-width,initial-scale=1"></head>');
  }

  return out;
}

/** Rewrite an HTML fragment (no <head>/<html> handling). */
function rewriteHtmlFragment(html, base, ctx, tag) {
  const inner =
    tag === 'noscript' || tag === 'noembed' || tag === 'noframes'
      ? mapInner(html, tag, (body) => rewriteHtmlFragment(body, base, ctx))
      : html;
  const parts = splitIslands(inner);
  return parts
    .map((part) => {
      if (!part.raw) return rewriteMarkupChunk(part.text, ctx);
      if (part.tag === 'style') return mapInner(part.text, 'style', (t) => rewriteCss(t, base, { reader: ctx.reader }));
      if (part.tag === 'script') return ctx.reader ? '' : part.text;
      return part.text;
    })
    .join('');
}

/** Rewrite every tag in a chunk of plain markup. */
function rewriteMarkupChunk(chunk, ctx) {
  return chunk.replace(/<([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (m, name, rest) => {
    const tagName = name.toLowerCase();
    const local = Object.assign({}, ctx, { tagName });
    return '<' + name + rewriteTag(rest, local) + '>';
  });
}

/** Script blocks may contain URLs the browser loads; only rewrite <script src>. */
function rewriteScriptBlock(block, ctx) {
  // The tag itself was already handled by rewriteTag? No — island chunks are
  // whole elements, so rewrite the open tag here.
  const m = /^(<script\b)([^>]*)(>)([\s\S]*)(<\/script\s*>)$/i.exec(block);
  if (!m) return block;
  const openAttrs = rewriteTag(m[2], Object.assign({}, ctx, { tagName: 'script' }));
  let body = m[4];

  // Some sites use <script type="text/template"> with HTML inside.
  const typeMatch = /\btype\s*=\s*["']([^"']+)["']/i.exec(openAttrs);
  const type = typeMatch ? typeMatch[1].toLowerCase() : '';
  if (/^text\/(template|html|x-template)$/.test(type) || type === 'application/ld+json') {
    body = rewriteHtmlFragment(body, ctx.base, ctx);
  }
  return m[1] + openAttrs + m[3] + body + m[5];
}

/* ------------------------------------------------------------------ */
/*  Reader mode                                                       */
/* ------------------------------------------------------------------ */

function readerStyles() {
  return `<style data-relay-reader="1">
html{-webkit-text-size-adjust:100%}
body{max-width:min(44rem,92vw)!important;margin:0 auto!important;padding:2.4rem 1.2rem 5rem!important;
 background:#0e131b!important;color:#dfe7f2!important;
 font:400 18px/1.72 ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif!important;
 letter-spacing:.002em}
body *{max-width:100%!important;box-sizing:border-box}
h1,h2,h3,h4,h5,h6{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif!important;
 line-height:1.24!important;letter-spacing:-.018em!important;color:#f3f7fd!important;margin:1.6em 0 .55em!important}
h1{font-size:1.95em}h2{font-size:1.5em}h3{font-size:1.24em}
p,li,dd,blockquote{font-size:1em!important}
a{color:#7dd3fc!important;text-decoration:underline;text-underline-offset:2px}
a:hover{color:#bfe7ff!important}
img,video,svg{height:auto!important;border-radius:8px}
figure{margin:1.4em 0}figcaption{font:400 13px/1.5 ui-sans-serif,system-ui,sans-serif!important;color:#93a3b8!important}
pre,code,kbd,samp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;font-size:.86em!important}
pre{background:#141b26!important;border:1px solid #22303f!important;border-radius:10px!important;
 padding:14px 16px!important;overflow:auto!important;line-height:1.5!important}
code{background:#141b26!important;padding:.12em .38em!important;border-radius:5px!important}
pre code{background:none!important;padding:0!important}
blockquote{margin:1.4em 0!important;padding:.2em 0 .2em 1.1em!important;border-left:3px solid #2b3a4d!important;color:#b7c6d9!important}
table{border-collapse:collapse!important;width:100%!important;font-size:.92em!important;display:block;overflow-x:auto}
th,td{border:1px solid #22303f!important;padding:.5em .7em!important;text-align:left!important}
hr{border:0;border-top:1px solid #22303f;margin:2em 0}
::selection{background:rgba(125,211,252,.32);color:#fff}
[style*="position:fixed"],[style*="position: fixed"]{position:static!important}
aside,nav,footer,[role="complementary"],[role="banner"]{max-width:100%!important}
@media print{body{background:#fff!important;color:#111!important}}
</style>`;
}


/* ------------------------------------------------------------------ */
/*  Streaming rewriter (for very large / streamed HTML)               */
/* ------------------------------------------------------------------ */

/**
 * Rewrites HTML as it streams. Because tags can straddle chunk boundaries we
 * keep a tail buffer and only emit up to the last complete `>`.
 */
class StreamRewriter {
  constructor(ctx, headInject = '') {
    this.ctx = ctx;
    this.pending = '';
    this.inRawTag = null;
    this.injected = false;
    this.headInject = headInject;
  }

  write(chunk) {
    this.pending += chunk;
    if (this.pending.length > 4 * 1024 * 1024) {
      // A single unterminated blob: flush raw to avoid unbounded memory.
      const out = this.pending;
      this.pending = '';
      return out;
    }
    const cut = this.pending.lastIndexOf('>');
    if (cut < 0) return '';
    const ready = this.pending.slice(0, cut + 1);
    this.pending = this.pending.slice(cut + 1);
    return this.transform(ready);
  }

  transform(text) {
    let out = '';
    // If we're inside a raw element, pass through until it closes.
    if (this.inRawTag) {
      const closeRe = new RegExp('</' + this.inRawTag + '\\s*>', 'i');
      const m = closeRe.exec(text);
      if (!m) return this.inRawTag === 'style' ? text : text;
      out += text.slice(0, m.index + m[0].length);
      text = text.slice(m.index + m[0].length);
      this.inRawTag = null;
    }

    const rawRe = /<(script|style|textarea|title|noscript|template|xmp)\b[^>]*>/i;
    const m = rawRe.exec(text);
    if (m) {
      const before = text.slice(0, m.index);
      const tagText = m[0];
      const after = text.slice(m.index + tagText.length);
      out += this.rewritePlain(before);
      const name = m[1].toLowerCase();
      out += this.rewritePlain(tagText).replace('<head>', '<head>' + this.takeHeadInject());
      if (name === 'script' && this.ctx.reader) {
        this.inRawTag = 'script';
      } else if (name === 'style') {
        this.inRawTag = 'style';
      } else {
        this.inRawTag = name;
      }
      if (after) out += this.transform(after);
      return out;
    }
    out += this.rewritePlain(text);
    return out;
  }

  takeHeadInject() {
    if (this.injected) return '';
    this.injected = true;
    return this.headInject;
  }

  rewritePlain(text) {
    let out = this.rewriteTags(text);
    if (!this.injected && /<head\b[^>]*>/i.test(out)) {
      out = out.replace(/<head\b[^>]*>/i, (mm) => mm + this.takeHeadInject());
    }
    return out;
  }

  rewriteTags(text) {
    return text.replace(/<([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (m, name, rest) => {
      const tagName = name.toLowerCase();
      if (tagName === 'base') return '';
      if (tagName === 'meta' && /http-equiv\s*=\s*["']?\s*(content-security-policy|refresh)/i.test(rest)) return '';
      const local = Object.assign({}, this.ctx, { tagName });
      return '<' + name + rewriteTag(rest, local) + '>';
    });
  }

  end() {
    let out = this.pending;
    this.pending = '';
    if (this.inRawTag && this.inRawTag !== 'style') out = out;
    out = this.rewritePlain(out);
    if (!this.injected) out += this.headInject; // nowhere to inject; append
    return out;
  }
}

/* ------------------------------------------------------------------ */
/*  Misc                                                              */
/* ------------------------------------------------------------------ */

function makeNonce() {
  return crypto.randomBytes(12).toString('hex');
}

/** Absolute-ise and proxify a URL used by the chrome (not a document). */
function proxiedFor(target, reader) {
  return proxifyUrl(target, { reader });
}

module.exports = {
  rewriteHtml,
  rewriteHtmlFragment,
  rewriteTag,
  rewriteCss,
  rewriteInlineStyle,
  rewriteSrcset,
  decodeEntities,
  escapeAttr,
  escapeHtml,
  jsString,
  StreamRewriter,
  clientRuntime,
  readerStyles,
  readerStylesInline: readerStyles,
  makeNonce,
  proxiedFor,
  splitIslands,
  MAX_HTML,
  SCHEMES_SKIP,
};
