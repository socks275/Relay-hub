'use strict';

/*
 * Upstream HTTP client.
 *
 * Node's built-in `fetch` is not enough here, for three reasons:
 *
 *  1. SSRF. We must resolve the hostname ourselves and refuse to connect when
 *     it resolves to a private/loopback address (DNS rebinding), and we must
 *     re-check on every redirect hop. fetch gives us no hook for that.
 *  2. Cookies. We need every Set-Cookie, including multiple ones, verbatim.
 *  3. Streaming + aborts + decompression we control.
 *
 * So this is a small, careful http/https client.
 */

const http = require('http');
const https = require('https');
const dns = require('dns');
const zlib = require('zlib');
const { URL } = require('url');
const { PassThrough } = require('stream');
const { isPrivateIP, isPrivateHostname, validateTarget, normaliseTarget } = require('./url');

/* ------------------------------------------------------------------ */
/*  Trust store                                                       */
/* ------------------------------------------------------------------ */

/*
 * Node ships its own CA bundle and ignores the OS trust store. That breaks
 * two very common real-world setups: corporate TLS-inspecting proxies, and
 * containers/hosts where an admin added a private CA. So by default we trust
 * Node's roots *plus* the system roots, and we honour NODE_EXTRA_CA_CERTS and
 * SSL_CERT_FILE. Set RELAY_STRICT_TLS=1 to go back to Node's bundle only.
 */
function buildTrustStore() {
  const seen = new Set();
  const certs = [];
  const add = (pem) => {
    if (!pem || typeof pem !== 'string') return;
    for (const block of pem.split(/(?=-----BEGIN CERTIFICATE-----)/)) {
      const trimmed = block.trim();
      if (!trimmed.includes('BEGIN CERTIFICATE')) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      certs.push(trimmed);
    }
  };

  if (process.env.RELAY_STRICT_TLS !== '1') {
    try {
      if (typeof tls.getCACertificates === 'function') {
        add(tls.getCACertificates('default'));
        add(tls.getCACertificates('system'));
      }
    } catch {
      /* older Node: fall through */
    }
    for (const file of [process.env.NODE_EXTRA_CA_CERTS, process.env.SSL_CERT_FILE]) {
      if (!file) continue;
      try {
        add(require('fs').readFileSync(file, 'utf8'));
      } catch {
        /* unreadable: ignore */
      }
    }
    // Common distro locations for the system bundle.
    for (const file of [
      '/etc/ssl/certs/ca-certificates.crt',
      '/etc/pki/tls/certs/ca-bundle.crt',
      '/etc/ssl/cert.pem',
      '/etc/ssl/ca-bundle.pem',
    ]) {
      try {
        add(require('fs').readFileSync(file, 'utf8'));
      } catch {
        /* not present: ignore */
      }
    }
  }

  if (!certs.length) return undefined;
  return certs;
}

let TRUST_STORE = null;
function trustStore() {
  if (TRUST_STORE === null) TRUST_STORE = buildTrustStore();
  return TRUST_STORE;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT = 30000;
const MAX_REDIRECTS = 10;

const ACCEPT_ENCODING = 'gzip, deflate, br';

/** DNS cache: host → { at, addrs } */
const dnsCache = new Map();
const DNS_TTL = 60 * 1000;

function lookupAll(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return reject(err);
      if (!addrs || !addrs.length) return reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
      resolve(addrs);
    });
  });
}

/**
 * Resolve a hostname to a safe address. Throws if *any* returned address is
 * private (a host that answers both public and private is up to no good).
 */
async function resolveSafe(hostname, opts = {}) {
  const host = String(hostname).toLowerCase();
  const allowPrivate =
    opts.allowPrivate ||
    process.env.RELAY_ALLOW_PRIVATE === '1' ||
    process.env.RELAY_TEST_ALLOW_PRIVATE === '1';

  if (!allowPrivate && isPrivateHostname(host)) {
    const err = new Error('Blocked: local/private address');
    err.code = 'EPRIVATE';
    throw err;
  }
  // Literal IP: no DNS needed.
  if (/^[0-9.]+$/.test(host) || host.startsWith('[') || host.indexOf(':') >= 0) {
    if (!allowPrivate && isPrivateIP(host.replace(/^\[|\]$/g, ''))) {
      const err = new Error('Blocked: local/private address');
      err.code = 'EPRIVATE';
      throw err;
    }
    return [{ address: host.replace(/^\[|\]$/g, ''), family: host.indexOf(':') >= 0 ? 6 : 4 }];
  }

  const cached = dnsCache.get(host);
  if (cached && Date.now() - cached.at < DNS_TTL) {
    return cached.addrs;
  }

  let addrs;
  try {
    addrs = await lookupAll(host);
  } catch (err) {
    const e = new Error(err.code === 'ENOTFOUND' ? 'ENOTFOUND' : err.code || 'EAI_AGAIN');
    e.code = err.code || 'EAI_AGAIN';
    throw e;
  }

  if (!allowPrivate) {
    for (const a of addrs) {
      if (isPrivateIP(a.address)) {
        const err = new Error('Blocked: resolves to a local/private address');
        err.code = 'EPRIVATE';
        throw err;
      }
    }
  }

  if (dnsCache.size > 5000) dnsCache.clear();
  dnsCache.set(host, { at: Date.now(), addrs });
  if (!opts.noCache && addrs.length > 1) {
    // Prefer IPv4 first for compatibility, but keep everything for fallback.
    addrs.sort((a, b) => (a.family === 4 ? -1 : 1) - (b.family === 4 ? -1 : 1));
  }
  return addrs;
}

/** A custom `lookup` for http.request that pins to our vetted addresses. */
function pinnedLookup(addrs) {
  let index = 0;
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const want = options && options.family;
    const candidates = want ? addrs.filter((a) => a.family === want) : addrs;
    const pool = candidates.length ? candidates : addrs;
    if (!pool.length) {
      const err = new Error('ENOTFOUND');
      err.code = 'ENOTFOUND';
      return callback(err);
    }
    const pick = pool[Math.min(index, pool.length - 1)];
    index++;
    if (options && options.all) return callback(null, pool);
    return callback(null, pick.address, pick.family);
  };
}

/* ------------------------------------------------------------------ */
/*  Request                                                           */
/* ------------------------------------------------------------------ */

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Decode a response stream based on Content-Encoding.
 * @returns {import('stream').Readable}
 */
function decodeStream(stream, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!enc || enc === 'identity') return stream;
  // Multiple encodings are applied left-to-right; decode in reverse.
  const layers = enc.split(',').map((s) => s.trim()).filter(Boolean).reverse();
  let out = stream;
  try {
    for (const layer of layers) {
      if (layer === 'gzip' || layer === 'x-gzip') out = out.pipe(zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }));
      else if (layer === 'deflate') out = out.pipe(zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH }));
      else if (layer === 'br') out = out.pipe(zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }));
      else return stream; // unknown encoding: hand back raw bytes
    }
  } catch {
    return stream;
  }
  // Swallow decompression errors so a truncated response doesn't crash us.
  out.on('error', () => {});
  return out;
}

/**
 * Perform one HTTP request with no redirect following.
 *
 * @returns {Promise<{status:number, headers:Object, stream:Readable, url:string, timings:Object}>}
 */
function requestOnce(targetUrl, opts = {}) {
  const url = new URL(targetUrl);
  const isHttps = url.protocol === 'https:';
  const mod = isHttps ? https : http;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };

    resolveSafe(url.hostname, opts)
      .then((addrs) => {
        const headers = Object.assign(
          {
            'user-agent': opts.userAgent || DEFAULT_UA,
            accept: '*/*',
            'accept-language': 'en-GB,en;q=0.9,en-US;q=0.8',
            'accept-encoding': ACCEPT_ENCODING,
          },
          opts.headers || {}
        );
        // Never forward these — they describe our connection, not the target.
        delete headers.host;
        delete headers.connection;
        delete headers['keep-alive'];
        delete headers['proxy-connection'];
        delete headers['transfer-encoding'];
        delete headers.upgrade;
        delete headers['content-length'];
        for (const k of Object.keys(headers)) {
          if (headers[k] === undefined || headers[k] === null) delete headers[k];
        }

        const reqOpts = {
          method: opts.method || 'GET',
          protocol: url.protocol,
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          headers,
          lookup: pinnedLookup(addrs),
          servername: isHttps && !/^[0-9.]+$/.test(url.hostname) ? url.hostname.replace(/^\[|\]$/g, '') : undefined,
          rejectUnauthorized: opts.rejectUnauthorized !== false,
          agent: false,
          timeout,
        };
        if (isHttps) {
          reqOpts.minVersion = 'TLSv1.2';
          const ca = trustStore();
          if (ca) reqOpts.ca = ca;
          if (opts.insecureTLS || process.env.RELAY_INSECURE_TLS === '1') {
            reqOpts.rejectUnauthorized = false;
          }
        }

        let req;
        try {
          req = mod.request(reqOpts, (res) => {
            const rawHeaders = res.headers;
            const stream = decodeStream(res, rawHeaders['content-encoding']);
            finish(null, {
              status: res.statusCode || 0,
              statusText: res.statusMessage || '',
              headers: rawHeaders,
              rawHeaders: res.rawHeaders,
              stream,
              url: url.href,
              timings: { start: Date.now() },
            });
          });
        } catch (err) {
          return finish(err);
        }

        req.on('timeout', () => {
          const err = new Error('Upstream timed out');
          err.code = 'ETIMEDOUT';
          req.destroy(err);
        });
        req.on('error', (err) => finish(err));

        if (opts.signal) {
          if (opts.signal.aborted) {
            req.destroy(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          } else {
            opts.signal.addEventListener('abort', () => {
              req.destroy(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
            }, { once: true });
          }
        }

        if (opts.body && opts.body.length) req.end(opts.body);
        else req.end();
      })
      .catch((err) => finish(err));
  });
}

/**
 * Fetch a URL, following redirects safely.
 *
 * @param {string} targetUrl
 * @param {object} opts
 *   method, headers, body, cookieJar, sessionId, timeout, maxRedirects,
 *   signal, onRedirect(hop) → void, allowInsecureTLS
 */
async function fetchWithRedirects(targetUrl, opts = {}) {
  const maxRedirects = opts.maxRedirects === undefined ? MAX_REDIRECTS : opts.maxRedirects;
  let current = targetUrl;
  let method = (opts.method || 'GET').toUpperCase();
  let body = opts.body || null;
  const hops = [];

  for (let i = 0; i <= maxRedirects; i++) {
    let checked;
    try {
      checked = validateTarget(current, { selfHosts: opts.selfHosts || [] });
    } catch (err) {
      err.code = err.code || 'EBADTARGET';
      throw err;
    }

    const headers = Object.assign({}, opts.headers || {});
    if (opts.cookieJar && opts.sessionId) {
      const cookie = opts.cookieJar.header(opts.sessionId, checked);
      if (cookie) headers.cookie = cookie;
    }

    const res = await requestOnce(checked, {
      method,
      headers,
      body,
      timeout: opts.timeout,
      signal: opts.signal,
      userAgent: opts.userAgent,
      insecureTLS: opts.insecureTLS,
      selfHosts: opts.selfHosts,
    });

    hops.push({ url: checked, status: res.status, headers: res.headers });

    // Persist cookies from this hop.
    if (opts.cookieJar && opts.sessionId) {
      const setCookie = collectSetCookies(res.headers);
      if (setCookie.length) opts.cookieJar.store(opts.sessionId, checked, setCookie);
    }

    if (isRedirect(res.status) && res.headers.location) {
      if (i === maxRedirects) {
        res.stream.destroy();
        const err = new Error('Too many redirects');
        err.code = 'EREDIRECT';
        throw err;
      }
      let next;
      try {
        next = new URL(res.headers.location, checked).href;
      } catch {
        res.stream.destroy();
        const err = new Error('Invalid redirect location');
        err.code = 'EREDIRECT';
        throw err;
      }
      // 303 (and historically 301/302 for POST) become GET without a body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = null;
      }
      res.stream.destroy();
      if (typeof opts.onRedirect === 'function') opts.onRedirect({ from: checked, to: next, status: res.status });
      current = next;
      continue;
    }

    return Object.assign(res, {
      url: checked,
      finalUrl: checked,
      method,
      hops,
    });
  }

  const err = new Error('Too many redirects');
  err.code = 'EREDIRECT';
  throw err;
}

function collectSetCookies(headers) {
  const raw = headers['set-cookie'];
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  // Node folds non-expiring cookies together in rare cases; split conservatively
  // on commas that begin a new `name=` pair.
  return String(raw).split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/).map((s) => s.trim()).filter(Boolean);
}

/** Buffer a response stream with a hard byte cap. */
function readAll(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        stream.destroy();
        const err = new Error('Response too large');
        err.code = 'ETOOLARGE';
        reject(err);
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** A pass-through we can hand out while also inspecting bytes. */
function tee(stream, onChunk) {
  const out = new PassThrough();
  stream.on('data', (c) => {
    try {
      onChunk(c);
    } catch {
      /* ignore */
    }
    out.write(c);
  });
  stream.on('end', () => out.end());
  stream.on('error', (e) => out.destroy(e));
  return out;
}

function clearDnsCache() {
  dnsCache.clear();
}

module.exports = {
  DEFAULT_UA,
  ACCEPT_ENCODING,
  MAX_REDIRECTS,
  resolveSafe,
  requestOnce,
  fetchWithRedirects,
  collectSetCookies,
  readAll,
  tee,
  decodeStream,
  clearDnsCache,
  trustStore,
  isRedirect,
  _dnsCache: dnsCache,
  normaliseTarget,
};
