// Pine — SSRF guard for the server-side Reader proxy.
//
// The Reader fetches arbitrary URLs on behalf of visitors, so every target
// is validated twice: once at URL level (scheme, port, reserved hostnames,
// IP literals in every notation) and again at connect time via a custom DNS
// `lookup` that checks the *actual* address being dialed. The second check
// is what closes DNS-rebinding / TOCTOU holes.
import dns from "node:dns";
import net from "node:net";

export class TargetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* IP literal parsing (inet_aton semantics)                            */
/* ------------------------------------------------------------------ */

// Parse an IPv4 literal in any notation — dotted ("127.0.0.1"), short
// ("127.1"), per-part hex/octal ("0x7f.1", "0177.0.0.1") or a bare
// integer/hex ("2130706433", "0x7f000001"). Returns a 32-bit number or null.
export function parseIPv4(host) {
  if (typeof host !== "string" || !host) return null;
  const parts = host.split(".");
  if (parts.length > 4) return null;
  const nums = [];
  for (const part of parts) {
    if (part === "") return null;
    let n;
    if (/^0x[0-9a-f]+$/i.test(part)) n = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part, 8);
    else if (/^[0-9]+$/.test(part)) n = parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(n) || n < 0) return null;
    nums.push(n);
  }
  // inet_aton: last part fills the remaining bytes.
  const last = nums[nums.length - 1];
  const maxLast = [0xffffffff, 0xffffff, 0xffff, 0xff][nums.length - 1];
  if (last > maxLast) return null;
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null;
  let value = last;
  for (let i = 0; i < nums.length - 1; i++) value += nums[i] * 2 ** (8 * (3 - i));
  return value >>> 0;
}

function ipv4IsPrivate(v) {
  const a = (v >>> 24) & 0xff, b = (v >>> 16) & 0xff;
  if (a === 0) return true;                                  // 0.0.0.0/8 "this network"
  if (a === 10) return true;                                 // 10/8 private
  if (a === 127) return true;                                // loopback
  if (a === 169 && b === 254) return true;                   // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;          // 172.16/12 private
  if (a === 192 && b === 0) return true;                     // 192.0.0.0/24 IETF special
  if (a === 192 && b === 168) return true;                   // 192.168/16 private
  if (a === 192 && b === 88 && ((v >>> 8) & 0xff) === 99) return true; // 6to4 relay (deprecated)
  if (a === 198 && (b === 18 || b === 19)) return true;      // 198.18/15 benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true;         // 100.64/10 CGNAT
  // Documentation ranges can never be real destinations:
  if (a === 192 && b === 0 && ((v >>> 8) & 0xff) === 2) return true;
  if (a === 198 && b === 51 && ((v >>> 8) & 0xff) === 100) return true;
  if (a === 203 && b === 0 && ((v >>> 8) & 0xff) === 113) return true;
  if (a >= 224) return true;                                 // multicast + reserved + broadcast
  return false;
}

// Expand an IPv6 literal into 16 bytes, or null if it isn't one.
export function parseIPv6(host) {
  if (typeof host !== "string" || !net.isIPv6(host)) return null;
  let h = host.toLowerCase();
  // IPv4-embedded suffix: replace with two hex groups.
  const v4 = h.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = parseIPv4(v4[1]);
    if (n === null) return null;
    h = h.slice(0, -v4[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(Math.max(missing, 0)).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

function ipv6IsPrivate(bytes) {
  const isMappedV4 = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (isMappedV4) return ipv4IsPrivate(((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0);
  if (bytes.every((b, i) => b === (i === 15 ? 1 : 0))) return true;          // ::1 loopback
  if (bytes.every((b) => b === 0)) return true;                               // :: unspecified
  if ((bytes[0] & 0xfe) === 0xfc) return true;                                // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;          // fe80::/10 link-local
  if (bytes[0] === 0xff) return true;                                         // multicast
  // 64:ff9b::/96 NAT64 well-known — embeds an IPv4 address.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((b) => b === 0))
    return ipv4IsPrivate(((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0);
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32 docs
  return false;
}

// Is this exact IP string (as returned by DNS or written in a URL) private
// or otherwise unsafe to connect to? Unknown formats fail closed.
export function isPrivateIp(ip) {
  if (typeof ip !== "string") return true;
  const v6 = parseIPv6(ip);
  if (v6) return ipv6IsPrivate(v6);
  const v4 = parseIPv4(ip);
  if (v4 !== null) return ipv4IsPrivate(v4);
  return true;
}

/* ------------------------------------------------------------------ */
/* Hostname / URL validation                                           */
/* ------------------------------------------------------------------ */

const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home", ".invalid", ".test", ".example", ".onion", ".corp"];
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
  "instance-data",
  "instance-data-compute",
]);

export function validateTarget(raw, { allowPrivate = false } = {}) {
  let url;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw new TargetError("That doesn't look like a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new TargetError("Only http:// and https:// pages can be fetched.");
  if (url.username || url.password)
    throw new TargetError("URLs with embedded credentials aren't allowed.");

  // Node's URL keeps the brackets on IPv6 literal hosts ("[::1]") — strip them.
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1");
  if (!host) throw new TargetError("The URL has no hostname.");

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!allowPrivate && port !== 80 && port !== 443)
    throw new TargetError(`Port ${port} isn't allowed (only 80 and 443).`, 403);

  if (!allowPrivate) {
    if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s)))
      throw new TargetError("That hostname is blocked.", 403);
    // Literal IP in any notation?
    if ((parseIPv4(host) !== null || parseIPv6(host)) && isPrivateIp(host))
      throw new TargetError("That IP address is private or reserved.", 403);
  }
  return url;
}

/* ------------------------------------------------------------------ */
/* DNS lookup with connect-time validation                             */
/* ------------------------------------------------------------------ */

// A dns.lookup-compatible function that refuses private results. Pass it to
// http(s).request via the `lookup` option so the *dialed* address is the
// *checked* address.
export function makeLookup({ allowPrivate = false } = {}) {
  return (hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    // IP literal — net would bypass lookup for dotted quads, but weird
    // notations route through DNS; answer those ourselves.
    const v4 = parseIPv4(hostname);
    if (v4 !== null || parseIPv6(hostname)) {
      if (!allowPrivate && isPrivateIp(hostname))
        return callback(Object.assign(new Error("Blocked private IP"), { code: "EBLOCKED" }));
      const family = parseIPv6(hostname) ? 6 : 4;
      const addr = v4 !== null && !hostname.includes(".") // bare integer form → dotted
        ? [(v4 >>> 24) & 255, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join(".")
        : hostname;
      return process.nextTick(() =>
        options.all ? callback(null, [{ address: addr, family }]) : callback(null, addr, family)
      );
    }
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses || !addresses.length)
        return callback(Object.assign(new Error(`DNS lookup failed for ${hostname}`), { code: "ENOTFOUND" }));
      // Fail closed if *any* returned address is private (rebinding trick).
      if (!allowPrivate) {
        for (const a of addresses) {
          if (isPrivateIp(a.address))
            return callback(Object.assign(new Error(`${hostname} resolves to a private IP`), { code: "EBLOCKED" }));
        }
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}
