'use strict';

/*
 * Server-side cookie jar.
 *
 * A rewriting proxy *is* the browser as far as the origin is concerned, so it
 * has to keep cookies itself. Keyed by (relay session, origin) so two visitors
 * to the same Relay instance never share a login.
 *
 * Implements the parts of RFC 6265 that matter in practice:
 *   - Domain / Path scoping and the default-path algorithm
 *   - Secure, HttpOnly, SameSite (stored, not enforced — we're the client)
 *   - Max-Age vs Expires, deletion with Max-Age=0
 *   - Host-only cookies (no Domain attribute)
 *   - Domain-match and path-match rules for sending
 */

const MAX_JARS = 2000;
const MAX_COOKIES_PER_JAR = 300;
const MAX_COOKIE_BYTES = 4096;

/** sessionId → Map(origin → Map(key → cookie)) */
const jars = new Map();

function jarFor(sessionId, origin, create) {
  let sid = jars.get(sessionId);
  if (!sid) {
    if (!create) return null;
    sid = new Map();
    jars.set(sessionId, sid);
    if (jars.size > MAX_JARS) {
      // Evict the oldest session (Map preserves insertion order).
      const oldest = jars.keys().next().value;
      if (oldest !== sessionId) jars.delete(oldest);
    }
  }
  let originJar = sid.get(origin);
  if (!originJar) {
    if (!create) return null;
    originJar = new Map();
    sid.set(origin, originJar);
    if (sid.size > 200) {
      const oldest = sid.keys().next().value;
      if (oldest !== origin) sid.delete(oldest);
    }
  }
  return originJar;
}

/** Default-path per RFC 6265 §5.1.4. */
function defaultPath(pathname) {
  if (!pathname || pathname[0] !== '/') return '/';
  const idx = pathname.lastIndexOf('/');
  if (idx <= 0) return '/';
  return pathname.slice(0, idx);
}

function pathMatch(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith('/')) return true;
  return requestPath[cookiePath.length] === '/';
}

function domainMatch(host, domain) {
  if (host === domain) return true;
  if (!host.endsWith('.' + domain)) return false;
  // Reject public suffixes of the form "com" / "co.uk" being used as a domain.
  if (domain.indexOf('.') < 0) return false;
  // Reject IP addresses as domains.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) return false;
  return true;
}

function parseSetCookie(header, requestUrl) {
  if (!header || typeof header !== 'string') return null;
  if (header.length > MAX_COOKIE_BYTES) return null;

  const parts = header.split(';');
  const first = parts.shift() || '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  let domain = null;
  let path = null;
  let secure = false;
  let httpOnly = false;
  let sameSite = null;
  let expiresAt = null;

  for (const attr of parts) {
    const i = attr.indexOf('=');
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : attr.slice(i + 1).trim();

    if (key === 'domain') {
      const d = val.replace(/^\./, '').toLowerCase();
      // RFC 6265 §5.3: if the Domain attribute doesn't domain-match the
      // request host, the *whole cookie* is ignored — it must not silently
      // degrade to a host-only cookie, or a site could pin a cookie it has
      // no right to set.
      if (!d || !domainMatch(url.hostname.toLowerCase(), d)) return null;
      domain = d;
    } else if (key === 'path') {
      path = val && val[0] === '/' ? val : null;
    } else if (key === 'secure') {
      secure = true;
    } else if (key === 'httponly') {
      httpOnly = true;
    } else if (key === 'samesite') {
      sameSite = val.toLowerCase();
    } else if (key === 'max-age') {
      const n = parseInt(val, 10);
      if (Number.isFinite(n)) expiresAt = n <= 0 ? 0 : Date.now() + n * 1000;
    } else if (key === 'expires' && expiresAt === null) {
      const t = Date.parse(val);
      if (Number.isFinite(t)) expiresAt = t;
    }
  }

  return {
    name,
    value,
    domain: domain || url.hostname.toLowerCase(),
    hostOnly: !domain,
    path: path || defaultPath(url.pathname),
    secure,
    httpOnly,
    sameSite,
    expiresAt,
    created: Date.now(),
  };
}

function cookieKey(c) {
  return c.domain + '|' + c.path + '|' + c.name;
}

/** Store response cookies into the jar for (session, origin). */
function store(sessionId, requestUrl, setCookieHeaders) {
  if (!setCookieHeaders || !setCookieHeaders.length) return;
  const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  const origin = url.origin;
  const jar = jarFor(sessionId, origin, true);
  const now = Date.now();

  for (const header of setCookieHeaders) {
    const c = parseSetCookie(header, url);
    if (!c) continue;
    const key = cookieKey(c);
    if (c.expiresAt !== null && c.expiresAt <= now) {
      jar.delete(key);
      continue;
    }
    jar.set(key, c);
    if (jar.size > MAX_COOKIES_PER_JAR) {
      // Drop the oldest few.
      const sorted = [...jar.entries()].sort((a, b) => a[1].created - b[1].created);
      for (let i = 0; i < 20 && i < sorted.length; i++) jar.delete(sorted[i][0]);
    }
  }
}

/** Build the Cookie header for a request. */
function header(sessionId, requestUrl) {
  const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  const jar = jarFor(sessionId, url.origin, false);
  if (!jar || !jar.size) return '';

  const host = url.hostname.toLowerCase();
  const pathname = url.pathname || '/';
  const secure = url.protocol === 'https:';
  const now = Date.now();
  const out = [];

  for (const [key, c] of jar) {
    if (c.expiresAt !== null && c.expiresAt <= now) {
      jar.delete(key);
      continue;
    }
    if (c.secure && !secure) continue;
    const hostOk = c.hostOnly ? host === c.domain : domainMatch(host, c.domain);
    if (!hostOk) continue;
    if (!pathMatch(pathname, c.path)) continue;
    out.push(c);
  }

  if (!out.length) return '';
  // Longer paths first, then earlier creation — matches browser behaviour
  // closely enough for servers that care about ordering.
  out.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  return out.map((c) => c.name + '=' + c.value).join('; ');
}

/** Serialise a jar to a list (used by the cookie manager API). */
function list(sessionId, origin) {
  const jar = jarFor(sessionId, origin, false);
  if (!jar) return [];
  const now = Date.now();
  return [...jar.values()]
    .filter((c) => c.expiresAt === null || c.expiresAt > now)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expiresAt: c.expiresAt,
    }));
}

function remove(sessionId, origin, name, domain, pathStr) {
  const jar = jarFor(sessionId, origin, false);
  if (!jar) return false;
  let removed = false;
  for (const [key, c] of jar) {
    if (c.name !== name) continue;
    if (domain && c.domain !== domain) continue;
    if (pathStr && c.path !== pathStr) continue;
    jar.delete(key);
    removed = true;
  }
  return removed;
}

function clearOrigin(sessionId, origin) {
  const sid = jars.get(sessionId);
  if (!sid) return false;
  return sid.delete(origin);
}

function clearSession(sessionId) {
  return jars.delete(sessionId);
}

function stats() {
  let sessions = 0;
  let cookies = 0;
  for (const sid of jars.values()) {
    sessions++;
    for (const jar of sid.values()) cookies += jar.size;
  }
  return { sessions, cookies };
}

/** Drop expired cookies periodically so long-running instances don't leak. */
function sweep() {
  const now = Date.now();
  for (const [sidKey, sid] of jars) {
    for (const [origin, jar] of sid) {
      for (const [key, c] of jar) {
        if (c.expiresAt !== null && c.expiresAt <= now) jar.delete(key);
      }
      if (!jar.size) sid.delete(origin);
    }
    if (!sid.size) jars.delete(sidKey);
  }
}

module.exports = {
  store,
  header,
  list,
  remove,
  clearOrigin,
  clearSession,
  stats,
  sweep,
  parseSetCookie,
  pathMatch,
  domainMatch,
  _jars: jars,
};
