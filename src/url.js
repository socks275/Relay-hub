'use strict';

/*
 * URL mapping + target validation.
 *
 * Everything the proxy exposes lives under one of these prefixes:
 *
 *   /fetch?url=<url>[&m=1]   rewritten HTML page   (legacy/simple, bookmarkable)
 *   /raw?url=<url>           un-rewritten stream   (images, media, files)
 *   /form/<b64url(url)>      form action target
 *   /p/<b64url(url)>/<path>  path-style proxy address (best for relative URLs)
 *
 * Internally we prefer base64url encoding because it survives being embedded
 * in inline JS, CSS, query strings and path segments without escaping games.
 */

const SCHEMES_SKIP = /^(?:#|javascript:|mailto:|tel:|sms:|data:|blob:|about:|chrome:|chrome-extension:|moz-extension:|file:|ftp:|magnet:|whatsapp:|intent:|market:|itms-apps:|vscode:|webcal:)/i;

/** Public prefixes we ever emit. */
const PREFIX = {
  fetch: '/fetch',
  raw: '/raw',
  form: '/form',
  path: '/p',
  ws: '/ws',
};

/* ------------------------------------------------------------------ */
/*  base64url                                                         */
/* ------------------------------------------------------------------ */

function b64url(str) {
  return Buffer.from(String(str), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function unb64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  return Buffer.from(s, 'base64').toString('utf8');
}

/** Decode a b64url segment that is supposed to contain a URL. */
function decodeTargetSegment(seg) {
  try {
    const out = unb64url(seg);
    if (!/^https?:\/\//i.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Private / reserved address detection                              */
/* ------------------------------------------------------------------ */

/**
 * Parse an IPv4 address in any of the forms browsers/curl accept:
 * dotted decimal, `127.1`, `0x7f.1`, hex, octal, and single integers.
 * Returns a normalised dotted quad or null.
 */
function parseIPv4(input) {
  if (typeof input !== 'string' || !input) return null;
  const parts = input.split('.');
  if (parts.length > 4) return null;

  const nums = [];
  for (const raw of parts) {
    if (raw === '') return null;
    let n;
    if (/^0[xX][0-9a-fA-F]+$/.test(raw)) n = parseInt(raw.slice(2), 16);
    else if (/^0[0-7]+$/.test(raw)) n = parseInt(raw, 8);
    else if (/^\d+$/.test(raw)) n = parseInt(raw, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }

  // Shortest forms (a, a.b, a.b.c) pack the remaining bytes into the last field.
  const last = nums.pop();
  const remainingBytes = 4 - nums.length;
  const max = 256 ** remainingBytes;
  if (nums.some((n) => n > 255) || last >= max) return null;

  const out = nums.slice();
  for (let i = remainingBytes - 1; i >= 0; i--) {
    out.push(Math.floor(last / 256 ** i) % 256);
  }
  return out.join('.');
}

/** Expand an IPv6 string to a 16-byte Buffer (or null). Handles `::` and v4 tails. */
function parseIPv6(input) {
  let s = String(input || '').trim().replace(/^\[|\]$/g, '');
  if (!s) return null;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.indexOf(':') < 0) return null;

  // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1) → two hex groups.
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const parsed = parseIPv4(v4[1]);
    if (!parsed) return null;
    const octets = parsed.split('.').map(Number);
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = s.slice(0, v4.index) + hi + ':' + lo;
  }

  // '::' may appear at most once, and ':::' is never valid.
  if (/:::[^:]/.test(s) && !/:::$/.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const split = (part) => (part ? part.split(':').filter((x) => x !== '') : []);

  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];

  const toGroups = (list) => {
    const out = [];
    for (const g of list) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const headGroups = toGroups(head);
  const tailGroups = toGroups(tail);
  if (!headGroups || !tailGroups) return null;

  let groups;
  if (halves.length === 2) {
    const fillCount = 8 - headGroups.length - tailGroups.length;
    if (fillCount < 1) return null; // '::' must stand for at least one group
    groups = headGroups.concat(new Array(fillCount).fill(0), tailGroups);
  } else {
    if (headGroups.length !== 8) return null;
    groups = headGroups;
  }

  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    buf[2 * i] = (groups[i] >> 8) & 0xff;
    buf[2 * i + 1] = groups[i] & 0xff;
  }
  return buf;
}

/** True when a literal IP (v4 or v6 buffer/string) is not publicly routable. */
function isPrivateIP(ip) {
  if (Buffer.isBuffer(ip)) {
    if (ip.length === 4) return isPrivateIPv4(ip.join('.'));
    if (ip.length !== 16) return true;
    // ::, ::1
    const isV6 = ip.slice(0, 10).every((b) => b === 0);
    if (isV6) {
      const last = ip[10] * 65536 + ip[11] * 256 + ip[12];
      if (last === 0 && ip[13] === 0 && ip[14] === 0 && ip[15] === 0) return true; // ::
      if (ip[10] === 0 && ip[11] === 0 && ip[12] === 0 && ip[13] === 0 && ip[14] === 0 && ip[15] === 1) return true; // ::1
      // v4-mapped ::ffff:a.b.c.d and v4-compatible ::a.b.c.d
      if (ip[10] === 0xff && ip[11] === 0xff) return isPrivateIPv4(ip.slice(12).join('.'));
      if (ip[10] === 0 && ip[11] === 0 && ip[12] === 0 && (ip[13] !== 0 || ip[14] !== 0 || ip[15] !== 0)) {
        return isPrivateIPv4(ip.slice(12).join('.'));
      }
    }
    // NAT64 64:ff9b::/96
    if (ip[0] === 0x00 && ip[1] === 0x64 && ip[2] === 0xff && ip[3] === 0x9b) {
      return isPrivateIPv4(ip.slice(12).join('.'));
    }
    // 6to4 2002::/16 — check the embedded v4
    if (ip[0] === 0x20 && ip[1] === 0x02) return isPrivateIPv4(ip.slice(2, 6).join('.'));
    // Unique local fc00::/7, link local fe80::/10, multicast ff00::/8
    if ((ip[0] & 0xfe) === 0xfc) return true;
    if (ip[0] === 0xfe && (ip[1] & 0xc0) === 0x80) return true;
    if (ip[0] === 0xfe && (ip[1] & 0xc0) === 0xc0) return true;
    if (ip[0] === 0xff) return true;
    // 100::/64 discard
    if (ip[0] === 0x01 && ip[1] === 0x00 && ip.slice(2, 8).every((b) => b === 0)) return true;
    return false;
  }
  if (typeof ip !== 'string') return true;
  if (ip.indexOf(':') >= 0) {
    const buf = parseIPv6(ip);
    return buf ? isPrivateIP(buf) : true;
  }
  return isPrivateIPv4(ip);
}

function isPrivateIPv4(str) {
  const norm = parseIPv4(str);
  if (!norm) return true;
  const [a, b, c] = norm.split('.').map(Number);
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // multicast + reserved + broadcast
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

const BLOCKED_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

/** Hostname-level block (cheap, no DNS). */
function isPrivateHostname(hostname) {
  const raw = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!raw) return true;
  if (raw.indexOf(':') >= 0) return isPrivateIP(raw);
  if (BLOCKED_NAMES.has(raw)) return true;
  if (/\.(localhost|local|internal|intranet|lan|home|corp|private|test|example|invalid|onion|i2p)$/.test(raw)) {
    // .example/.test/.invalid are reserved by RFC 2606 — but they may still be
    // used by someone's local DNS. Refuse: no legitimate public site uses them.
    return true;
  }
  if (/^\d+$/.test(raw) || /^0x[0-9a-f]+$/i.test(raw)) return isPrivateIP(parseIPv4(raw) || '0.0.0.0');
  if (/^[0-9.]+$/.test(raw) || /^[0-9a-fx.]+$/i.test(raw)) {
    const v4 = parseIPv4(raw);
    if (v4) return isPrivateIPv4(v4);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Target validation                                                 */
/* ------------------------------------------------------------------ */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

class TargetError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TargetError';
    this.status = status || 400;
  }
}

/**
 * Validate a URL coming from the client. Throws TargetError with a
 * user-presentable message. Returns a normalised href string.
 */
function validateTarget(raw, opts = {}) {
  if (raw === undefined || raw === null || raw === '') {
    throw new TargetError('No URL was given.');
  }
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new TargetError('That doesn’t look like a valid URL.');
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    throw new TargetError('Only http:// and https:// addresses can be proxied.');
  }
  if (u.username || u.password) {
    // Credentials in the URL leak into logs and break the cookie model; and
    // `https://user@evil` style tricks are a classic SSRF bypass.
    u.username = '';
    u.password = '';
  }
  if (!u.hostname) throw new TargetError('That URL has no hostname.');

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Private literal IPs / reserved names: blocked unless the operator
  // explicitly opted in (RELAY_ALLOW_PRIVATE=1, for LAN-only deployments),
  // or the test harness set RELAY_TEST_ALLOW_PRIVATE=1.
  const allowPrivate =
    opts.allowPrivate ||
    process.env.RELAY_ALLOW_PRIVATE === '1' ||
    process.env.RELAY_TEST_ALLOW_PRIVATE === '1';

  // Loop guard: never let Relay fetch itself. Skipped when the operator has
  // opted into private targets, because then "the proxy" may legitimately be
  // another local service.
  if (!allowPrivate) {
    const own = opts.selfHosts || [];
    if (own.some((h) => h && (h === host || host.endsWith('.' + h)))) {
      throw new TargetError('A proxy can’t proxy itself (that would loop forever).');
    }
  }

  if (!allowPrivate && isPrivateHostname(host)) {
    throw new TargetError('Local and private network addresses are blocked.');
  }

  if (u.port && !opts.allowAnyPort && !allowPrivate) {
    // Keep the proxy from being used as an arbitrary port scanner.
    const p = Number(u.port);
    const okPorts = new Set([80, 443, 8080, 8443, 8000, 8888, 3000, 5000, 9000, 2082, 2083, 2086, 2087, 2095, 2096]);
    if (p < 1 || p > 65535) throw new TargetError('That port isn’t valid.');
    if (!okPorts.has(p)) {
      throw new TargetError('Non-standard ports are blocked — Relay only proxies common web ports.');
    }
  }
  return u.href;
}

function normaliseTarget(raw) {
  try {
    const u = new URL(String(raw));
    if (!ALLOWED_PROTOCOLS.has(u.protocol)) return null;
    return u.href;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Building proxy URLs                                               */
/* ------------------------------------------------------------------ */

/** Percent-encode a URL for use as a query value (keeps it readable-ish). */
function encodeTarget(url) {
  return encodeURIComponent(url);
}

/**
 * Build a path-style proxy URL for `target`.
 * @param {string} target absolute http(s) URL
 * @param {{reader?:boolean, hash?:string, prefix?:string}} opts
 */
function proxify(target, opts = {}) {
  const prefix = opts.prefix || PREFIX.path;
  const base = prefix + '/' + b64url(target);
  const q = opts.reader ? '?m=1' : '';
  const hash = opts.hash && opts.hash.length > 1 ? opts.hash : '';
  return base + q + hash;
}

/**
 * Best-form proxy URL: keep the original path so that relative URLs inside
 * the page resolve correctly *even if* an inline script builds one by hand
 * with `location.pathname` tricks. Falls back to the b64 form for query-heavy
 * URLs where the path would be huge.
 */
function proxifyUrl(target, opts = {}) {
  const t = normaliseTarget(target);
  if (!t) return target;
  const u = new URL(t);
  const tooLong = t.length > 1400;
  if (tooLong) {
    return (
      PREFIX.fetch +
      '?url=' + encodeTarget(t) +
      (opts.reader ? '&m=1' : '') +
      (opts.hash || '')
    );
  }
  // Keep the target path visible: /p/<b64(origin+search)>/<path>
  const originPart = u.origin + u.pathname.replace(/\/?$/, '/');
  const pathTail = u.pathname.replace(/^\//, '');
  if (!pathTail) {
    return PREFIX.path + '/' + b64url(t) + (opts.reader ? '?m=1' : '') + (opts.hash || '');
  }
  void originPart;
  return PREFIX.path + '/' + b64url(t) + (opts.reader ? '?m=1' : '') + (opts.hash || '');
}

/** Resolve whatever came back out of a proxied URL to the real target. */
function targetFromProxyUrl(input, base) {
  let abs;
  try {
    abs = new URL(String(input), base || 'http://relay.invalid');
  } catch {
    return null;
  }
  if (!/^https?:$/.test(abs.protocol)) return null;
  const p = abs.pathname;
  if (p === PREFIX.fetch || p === PREFIX.raw) {
    const v = abs.searchParams.get('url');
    if (!v) return null;
    const t = normaliseTarget(v);
    return t ? { target: t, reader: abs.searchParams.get('m') === '1', hash: abs.hash } : null;
  }
  if (p.startsWith(PREFIX.path + '/')) {
    const seg = p.slice(PREFIX.path.length + 1).split('/')[0];
    const t = decodeTargetSegment(seg);
    return t ? { target: t, reader: abs.searchParams.get('m') === '1', hash: abs.hash } : null;
  }
  if (p.startsWith(PREFIX.form + '/')) {
    const seg = p.slice(PREFIX.form.length + 1).split('/')[0];
    const t = decodeTargetSegment(seg);
    return t ? { target: t, form: true } : null;
  }
  return null;
}

/**
 * Rewrite a single URL found in a document.
 * Returns the input unchanged for non-proxyable schemes.
 */
function rewriteUrl(raw, opts = {}) {
  if (raw === undefined || raw === null) return raw;
  const str = String(raw);
  const trimmed = str.trim();
  if (!trimmed) return str;
  if (SCHEMES_SKIP.test(trimmed)) return str;

  const base = opts.base;
  const mode = opts.mode || 'link'; // link | asset | form | open | raw

  // Unwrap our own URLs so we never double-proxy.
  const already = unwrapOwnUrl(trimmed, base);
  if (already) return already;

  let abs;
  try {
    abs = new URL(trimmed, base);
  } catch {
    return str;
  }

  if (!ALLOWED_PROTOCOLS.has(abs.protocol)) {
    // ws:// links become /ws/ so live sockets survive.
    if (abs.protocol === 'ws:' || abs.protocol === 'wss:') {
      return buildWsUrl(abs.href);
    }
    return str;
  }

  abs = unwrapTrackingRedirect(abs);

  if (mode === 'form') {
    return PREFIX.form + '/' + b64url(abs.href) + (abs.hash || '');
  }
  if (mode === 'raw') {
    return PREFIX.raw + '?url=' + encodeTarget(abs.href);
  }
  const hash = abs.hash;
  abs.hash = '';
  const out = proxify(abs.href, { reader: opts.reader && mode === 'link', hash });
  return out;
}

/** If the URL is already one of ours, return the inner target (de-proxied). */
function unwrapOwnUrl(raw, base) {
  if (!/(?:^|\/)(?:fetch|raw|p|form)\//.test(raw) && !/[?&]url=/.test(raw)) return null;
  let abs;
  try {
    abs = new URL(raw, base || 'http://relay.invalid');
  } catch {
    return null;
  }
  const p = abs.pathname;
  if (p === PREFIX.fetch || p === PREFIX.raw) {
    const v = abs.searchParams.get('url');
    if (!v) return null;
    const t = normaliseTarget(v);
    if (!t) return null;
    return proxify(t, { reader: abs.searchParams.get('m') === '1', hash: abs.hash });
  }
  if (p.startsWith(PREFIX.path + '/') || p.startsWith(PREFIX.form + '/')) {
    const prefix = p.startsWith(PREFIX.path) ? PREFIX.path : PREFIX.form;
    const seg = p.slice(prefix.length + 1).split('/')[0];
    const t = decodeTargetSegment(seg);
    if (!t) return null;
    return proxify(t, { reader: abs.searchParams.get('m') === '1', hash: abs.hash });
  }
  return null;
}

function buildWsUrl(target) {
  return PREFIX.ws + '?url=' + encodeTarget(target);
}

/**
 * Known click-tracking / interstitial redirectors. We unwrap them at rewrite
 * time so a proxied link goes straight to the real destination.
 */
function unwrapTrackingRedirect(u) {
  const host = u.hostname.toLowerCase();
  try {
    if (/(^|\.)bing\.com$/.test(host) && /^\/ck\/a/.test(u.pathname)) {
      const v = u.searchParams.get('u');
      if (v && /^a1/i.test(v)) {
        const dec = Buffer.from(v.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        if (/^https?:\/\//i.test(dec)) return new URL(dec);
      }
    }
    if (/(^|\.)duckduckgo\.com$/.test(host) && /^\/l\//.test(u.pathname)) {
      const v = u.searchParams.get('uddg');
      if (v && /^https?:\/\//i.test(v)) return new URL(v);
    }
    if (/(^|\.)google\.[a-z.]+$/.test(host) && u.pathname === '/url') {
      const v = u.searchParams.get('q') || u.searchParams.get('url');
      if (v && /^https?:\/\//i.test(v)) return new URL(v);
    }
  } catch {
    /* keep as-is */
  }
  return u;
}

/** Turn `example.com`, `www.example.com/path` or `localhost:3000` into a URL guess. */
function looksLikeHost(value) {
  const v = String(value || '').trim();
  if (!v || /\s/.test(v)) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return null;
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(v) && !/:\/\//.test(v)) return null; // mailto: etc.
  const m = /^((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}|localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d{1,5})?([/?#].*)?$/i.exec(v);
  if (!m) return null;
  return 'https://' + v;
}

module.exports = {
  PREFIX,
  b64url,
  unb64url,
  decodeTargetSegment,
  parseIPv4,
  parseIPv6,
  isPrivateIP,
  isPrivateIPv4,
  isPrivateHostname,
  validateTarget,
  normaliseTarget,
  TargetError,
  encodeTarget,
  proxify,
  proxifyUrl,
  targetFromProxyUrl,
  rewriteUrl,
  unwrapOwnUrl,
  unwrapTrackingRedirect,
  buildWsUrl,
  looksLikeHost,
  SCHEMES_SKIP,
};
