#!/usr/bin/env node
// Pine 🌲 — a self-hosted web hub with a Scramjet-powered proxy.
//
// One Node process serves everything:
//   /                 the Pine hub (Home · Play · Apps · Chat · AI · Listen · Watch · Browse)
//   /sw.js            the Scramjet service worker
//   /scram/*          Scramjet bundles (pinned from npm, served locally)
//   /controller/*     Scramjet controller bundles
//   /clients/*       libcurl / epoxy transports
//   /wisp/            Wisp WebSocket proxy (where all proxied traffic flows)
//   /chat             community-chat WebSocket
//   /api/fetch        Reader mode — the server-side fallback engine
//   /api/*            config, suggestions, study answers, health
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { server as wisp, logging as wispLogging } from "@mercuryworkshop/wisp-js/server";

import { config as baseConfig, log } from "./src/config.js";
import { createStatic } from "./src/static.js";
import { handleFetch, fetchJson } from "./src/fetchproxy.js";
import { createChat } from "./src/chat.js";

const nm = (...p) => path.join(baseConfig.root, "node_modules", ...p);

/* ------------------------------------------------------------------ */
/* Wisp setup                                                          */
/* ------------------------------------------------------------------ */
export function configureWisp(cfg) {
  wisp.options.allow_private_ips = cfg.allowPrivate;
  wisp.options.allow_loopback_ips = cfg.allowPrivate;
  wisp.options.wisp_motd = "Pine 🌲";
  if (cfg.blockHosts.length) {
    wisp.options.hostname_blacklist = cfg.blockHosts.map(
      (h) => new RegExp("(^|\\.)" + h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i")
    );
  }
  if (cfg.dnsServers.length) {
    wisp.options.dns_method = "resolve";
    wisp.options.dns_servers = cfg.dnsServers;
    wisp.options.dns_result_order = "ipv4first";
  }
  const map = { silent: wispLogging.NONE, error: wispLogging.ERROR, warn: wispLogging.WARN, info: wispLogging.INFO, debug: wispLogging.DEBUG };
  wispLogging.set_level(map[cfg.logLevel] ?? wispLogging.WARN);
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */
export function createPineServer(overrides = {}) {
  const cfg = { ...baseConfig, ...overrides };
  configureWisp(cfg);
  const chat = createChat();

  const staticHandler = createStatic({
    mounts: [
      // Everything in public/ — index.html, css/, js/, games/, icons.
      { prefix: "/", dir: cfg.publicDir, maxAge: 0 },
    ],
    fileMounts: new Map([
      ["/", { file: path.join(cfg.publicDir, "index.html"), maxAge: 0 }],
      ["/sw.js", { file: path.join(cfg.publicDir, "sw.js"), maxAge: 0 }],
      // Scramjet (canonical paths — the controller references these).
      ["/scram/scramjet.js", { file: nm("@mercuryworkshop/scramjet/dist/scramjet.js"), maxAge: 3600 }],
      ["/scram/scramjet.wasm", { file: nm("@mercuryworkshop/scramjet/dist/scramjet.wasm"), maxAge: 3600 }],
      ["/scram/scramjet-utils.js", { file: nm("@mercuryworkshop/scramjet-utils/dist/scramjet-utils.js"), maxAge: 3600 }],
      ["/controller/controller.api.js", { file: nm("@mercuryworkshop/scramjet-controller/dist/controller.api.js"), maxAge: 3600 }],
      ["/controller/controller.inject.js", { file: nm("@mercuryworkshop/scramjet-controller/dist/controller.inject.js"), maxAge: 3600 }],
      ["/controller/controller.sw.js", { file: nm("@mercuryworkshop/scramjet-controller/dist/controller.sw.js"), maxAge: 0 }],
      // Transports (self-contained bundles; sibling .wasm served as insurance).
      ["/clients/libcurl-client.js", { file: nm("@mercuryworkshop/libcurl-transport/dist/index.js"), maxAge: 3600 }],
      ["/clients/libcurl.wasm", { file: nm("libcurl.js/libcurl.wasm"), maxAge: 3600 }],
      ["/clients/epoxy-client.js", { file: nm("@mercuryworkshop/epoxy-transport/dist/index.js"), maxAge: 3600 }],
      ["/clients/epoxy.wasm", { file: nm("@mercuryworkshop/epoxy-tls/full/epoxy.wasm"), maxAge: 3600 }],
    ]),
  });

  /* tiny in-memory caches for API helpers */
  const suggestCache = new Map();
  let egressCache = { at: 0, value: null };

  /* per-IP token bucket for /api/fetch etc. */
  const buckets = new Map();
  function rateLimited(ip) {
    if (!cfg.rateLimit) return false;
    const now = Date.now();
    const b = buckets.get(ip) || { tokens: cfg.rateLimit, at: now };
    const refill = ((now - b.at) / 60000) * cfg.rateLimit;
    b.tokens = Math.min(cfg.rateLimit, b.tokens + refill);
    b.at = now;
    if (b.tokens < 1) { buckets.set(ip, b); return true; }
    b.tokens -= 1;
    buckets.set(ip, b);
    if (buckets.size > 10000) buckets.clear();
    return false;
  }
  const clientIp = (req) =>
    cfg.trustProxy && req.headers["x-forwarded-for"]
      ? String(req.headers["x-forwarded-for"]).split(",")[0].trim()
      : req.socket.remoteAddress || "-";

  /* optional basic-auth gate */
  let authFailures = new Map();
  function authed(req) {
    if (!cfg.authPass) return true;
    const now = Date.now();
    const ip = clientIp(req);
    const fails = (authFailures.get(ip) || []).filter((t) => now - t < 60000);
    if (fails.length >= 10) return false;
    const header = req.headers.authorization || "";
    if (!header.startsWith("Basic ")) return false;
    let decoded = "";
    try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch { return false; }
    const expected = Buffer.from(`${cfg.authUser}:${cfg.authPass}`);
    const actual = Buffer.from(decoded);
    const ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!ok) {
      fails.push(now);
      authFailures.set(ip, fails);
      if (authFailures.size > 5000) authFailures = new Map();
    } else {
      authFailures.delete(ip); // a good login clears the slate
    }
    return ok;
  }

  const startedAt = Date.now();
  let requestCount = 0;

  async function handleApi(req, res, pathname, query) {
    const json = (status, obj) => {
      const buf = Buffer.from(JSON.stringify(obj));
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": buf.length, "cache-control": "no-store" });
      res.end(buf);
    };

    if (pathname === "/api/config") {
      return json(200, {
        name: "pine",
        version: cfg.version,
        engines: ["scramjet", "reader", "direct"],
        defaultEngine: "scramjet",
        transports: ["libcurl", "epoxy"],
        defaultTransport: "libcurl",
        wispPath: "/wisp/",
        chatPath: "/chat",
        auth: Boolean(cfg.authPass),
        uptime: Math.round((Date.now() - startedAt) / 1000),
        requests: requestCount,
      });
    }
    if (pathname === "/api/ping") {
      res.writeHead(204, { "cache-control": "no-store" });
      return res.end();
    }
    if (pathname === "/api/stats") {
      const mem = process.memoryUsage();
      return json(200, {
        uptime: Math.round((Date.now() - startedAt) / 1000),
        requests: requestCount,
        memoryMB: Math.round(mem.rss / 1048576),
        chat: chat.stats(),
        node: process.version,
      });
    }
    if (pathname === "/api/egress") {
      if (Date.now() - egressCache.at < 5 * 60000 && egressCache.value) return json(200, egressCache.value);
      try {
        const data = await fetchJson("https://api.ipify.org?format=json", cfg, { timeout: 3000 });
        egressCache = { at: Date.now(), value: { ip: data.ip || null } };
      } catch {
        egressCache = { at: Date.now(), value: { ip: null } };
      }
      return json(200, egressCache.value);
    }
    if ((pathname === "/api/suggest" || pathname === "/api/answer") && rateLimited(clientIp(req)))
      return json(429, { error: "rate-limited" });
    if (pathname === "/api/suggest") {
      const q = (query.get("q") || "").slice(0, 120);
      if (!q) return json(200, { suggestions: [] });
      const hit = suggestCache.get(q.toLowerCase());
      if (hit && Date.now() - hit.at < 60000) return json(200, { suggestions: hit.value });
      let suggestions = [];
      try {
        const data = await fetchJson(
          `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=json`,
          cfg,
          { timeout: 3000 }
        );
        suggestions = (Array.isArray(data) ? data : [])
          .map((d) => (typeof d === "string" ? d : d.phrase))
          .filter(Boolean)
          .slice(0, 8);
      } catch { /* suggestions are best-effort */ }
      suggestCache.set(q.toLowerCase(), { at: Date.now(), value: suggestions });
      if (suggestCache.size > 500) suggestCache.clear();
      return json(200, { suggestions });
    }
    if (pathname === "/api/answer") {
      const q = (query.get("q") || "").slice(0, 200);
      if (!q) return json(200, { answer: null });
      try {
        const data = await fetchJson(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1&no_redirect=1`,
          cfg,
          { timeout: 5000 }
        );
        return json(200, {
          heading: data.Heading || null,
          abstract: data.AbstractText || null,
          abstractUrl: data.AbstractURL || null,
          answer: data.Answer || null,
          definition: data.Definition || null,
          related: (data.RelatedTopics || [])
            .filter((t) => t && t.Text && t.FirstURL)
            .slice(0, 5)
            .map((t) => ({ text: t.Text, url: t.FirstURL })),
        });
      } catch {
        return json(200, { answer: null, error: "lookup-failed" });
      }
    }
    if (pathname === "/api/fetch") {
      if (rateLimited(clientIp(req))) {
        res.writeHead(429, { "content-type": "text/plain" });
        return res.end("Too many requests — slow down a bit.");
      }
      return handleFetch(req, res, cfg);
    }
    return json(404, { error: "not-found" });
  }

  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    requestCount++;
    // Cross-origin isolation (lets the Scramjet transports use threads)
    // without the breakage of require-corp.
    res.setHeader("cross-origin-opener-policy", "same-origin");
    res.setHeader("cross-origin-embedder-policy", "credentialless");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("permissions-policy", "interest-cohort=()");

    let parsed;
    try {
      parsed = new URL(req.url || "/", "http://pine.internal");
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      return res.end("Bad request");
    }
    const pathname = parsed.pathname;

    res.on("finish", () => {
      const ms = Math.round(performance.now() - started);
      const noisy = pathname.startsWith("/scram/") || pathname.startsWith("/clients/") || pathname.startsWith("/controller/");
      (noisy ? log.debug : log.info)(`${req.method} ${pathname} ${res.statusCode} ${ms}ms ${clientIp(req)}`);
    });

    try {
      if (pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("ok");
      }
      if (!authed(req)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="Pine"', "content-type": "text/plain" });
        return res.end("Pine is password-protected. 🌲");
      }
      if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname, parsed.searchParams);

      // Scramjet-namespaced URLs only make sense through the service worker.
      if (pathname.startsWith("/lessons/")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(
          `<!doctype html><meta charset="utf-8"><title>Loading…</title>` +
          `<p style="font-family:system-ui">The Pine proxy worker isn't running yet. <a href="/">Return to Pine</a> and try again.</p>`
        );
      }

      if (await staticHandler(req, res, pathname)) return;

      // SPA fallback for in-app routes like /?goto= or plain unknown paths.
      const wantsHtml = String(req.headers.accept || "").includes("text/html");
      if (req.method === "GET" && wantsHtml && !path.extname(pathname)) {
        if (await staticHandler(req, res, "/")) return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found 🌲");
    } catch (err) {
      log.error("request failed", req.method, pathname, err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("Something snapped in the forest. Try again.");
      } else {
        res.destroy();
      }
    }
  });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try { pathname = new URL(req.url || "/", "http://pine.internal").pathname; } catch { socket.destroy(); return; }
    if (cfg.authPass && !authed(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (pathname.startsWith("/wisp/") || pathname === "/wisp") {
      wisp.routeRequest(req, socket, head);
      return;
    }
    if (pathname === "/chat") {
      chat.handleUpgrade(req, socket, head);
      return;
    }
    socket.destroy();
  });

  server.headersTimeout = 30000;
  server.requestTimeout = 120000;
  return { server, chat, cfg };
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { server, chat, cfg } = createPineServer();
  server.listen(cfg.port, cfg.host, () => {
    log.info("");
    log.info("  🌲 Pine is growing");
    log.info(`     Hub       http://${cfg.host}:${cfg.port}/`);
    log.info(`     Wisp      ws://${cfg.host}:${cfg.port}/wisp/`);
    log.info(`     Chat      ws://${cfg.host}:${cfg.port}/chat`);
    log.info(`     Auth      ${cfg.authPass ? `on (user: ${cfg.authUser})` : "off — set PINE_PASS to enable"}`);
    if (cfg.allowPrivate) log.warn("     ⚠ PINE_ALLOW_PRIVATE=1 — private/loopback targets allowed (SSRF guard relaxed)");
    log.info("");
  });
  const shutdown = (signal) => {
    log.info(`\n${signal} — shutting down…`);
    chat.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
