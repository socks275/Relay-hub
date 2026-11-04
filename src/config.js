// Pine — runtime configuration, all from the environment.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const bool = (name, fallback = false) => {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
};
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined ? v : fallback;
};
const list = (name) =>
  (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  root,
  publicDir: path.join(root, "public"),
  version: "1.0.0",

  port: num("PORT", 3000),
  host: process.env.HOST || "0.0.0.0",

  // Optional HTTP Basic auth gate for the whole site. Off unless PINE_PASS set.
  authUser: process.env.PINE_USER || "pine",
  authPass: process.env.PINE_PASS || "",

  // SSRF: allow the server-side Reader + Wisp to reach private/loopback IPs.
  // Only enable on a trusted LAN / in tests. Default off.
  allowPrivate: bool("PINE_ALLOW_PRIVATE"),

  // Wisp: comma-separated hostnames to block (exact + subdomains).
  blockHosts: list("PINE_BLOCK_HOSTS"),
  // Wisp: optional custom DNS servers, e.g. "1.1.1.1,1.0.0.1".
  dnsServers: list("PINE_DNS_SERVERS"),

  // Reader proxy limits.
  fetchTimeout: num("PINE_FETCH_TIMEOUT", 20000),
  maxHtml: num("PINE_MAX_HTML", 8 * 1024 * 1024),
  maxStream: num("PINE_MAX_STREAM", 64 * 1024 * 1024),

  // Requests per minute per IP on /api/fetch & friends. 0 = off.
  rateLimit: num("PINE_RATE_LIMIT", 0),

  logLevel: process.env.PINE_LOG_LEVEL || "info",
  trustProxy: bool("PINE_TRUST_PROXY", true),
};

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const level = LEVELS[config.logLevel] ?? 3;
export const log = {
  error: (...a) => level >= 1 && console.error(...a),
  warn: (...a) => level >= 2 && console.warn(...a),
  info: (...a) => level >= 3 && console.log(...a),
  debug: (...a) => level >= 4 && console.log(...a),
};
