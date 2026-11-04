import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";
import { createPineServer, configureWisp } from "../server.js";

/* A tiny upstream website to proxy. */
const fixture = http.createServer((req, res) => {
  const u = new URL(req.url, "http://fixture");
  if (u.pathname === "/hello") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("hello from upstream");
  }
  if (u.pathname === "/page") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><html><head><title>Fixture Page</title>
      <link rel="stylesheet" href="/style.css"><script>alert("nope")</script></head>
      <body><h1>Fixture</h1><a href="/page2">two</a><img src="/img.png"></body></html>`);
  }
  if (u.pathname === "/style.css") {
    res.writeHead(200, { "content-type": "text/css" });
    return res.end(`body{background:url(/bg.png)} @import "/more.css";`);
  }
  if (u.pathname === "/img.png" || u.pathname === "/bg.png") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  if (u.pathname === "/redir") {
    res.writeHead(302, { location: "/page" });
    return res.end();
  }
  if (u.pathname === "/echo") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>method=${req.method} body=${body}</body></html>`);
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("nope");
});

let pine, strictPine, authPine, port, strictPort, authPort, fixturePort;
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const base = (p) => `http://127.0.0.1:${p}`;
const fixtureUrl = (path) => `http://127.0.0.1:${fixturePort}${path}`;

before(async () => {
  fixturePort = await listen(fixture);
  pine = createPineServer({ allowPrivate: true, logLevel: "silent" });
  port = await listen(pine.server);
});

after(async () => {
  for (const p of [pine, strictPine, authPine]) {
    if (!p) continue;
    p.chat.close();
    p.server.closeAllConnections?.();
    p.server.close();
  }
  fixture.closeAllConnections?.();
  fixture.close();
});

/* ---------------- basics & assets ---------------- */

test("healthz + isolation headers", async () => {
  const res = await fetch(`${base(port)}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
  const page = await fetch(`${base(port)}/`);
  assert.equal(page.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(page.headers.get("cross-origin-embedder-policy"), "credentialless");
  const html = await page.text();
  assert.match(html, /Student Practice Center/);
  assert.match(html, /data-view="browse"/);
});

test("service worker + scramjet assets served with right types", async () => {
  const sw = await (await fetch(`${base(port)}/sw.js`)).text();
  assert.match(sw, /controller\.sw\.js/);
  assert.match(sw, /shouldRoute/);
  const wasm = await fetch(`${base(port)}/scram/scramjet.wasm`);
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  assert.ok((await wasm.arrayBuffer()).byteLength > 100_000);
  for (const p of ["/scram/scramjet.js", "/controller/controller.api.js", "/controller/controller.inject.js", "/controller/controller.sw.js", "/scram/scramjet-utils.js", "/clients/libcurl-client.js", "/clients/epoxy-client.js"]) {
    const r = await fetch(base(port) + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-type"), /javascript/, p);
    await r.arrayBuffer(); // drain
  }
});

test("static compression, etag revalidation, traversal refusal", async () => {
  const gz = await new Promise((resolve, reject) => {
    http.get(`${base(port)}/scram/scramjet.js`, { headers: { "accept-encoding": "gzip" } }, (r) => {
      r.resume();
      r.on("end", () => resolve(r));
    }).on("error", reject);
  });
  assert.equal(gz.headers["content-encoding"], "gzip");
  const first = await fetch(`${base(port)}/css/app.css`);
  const etag = first.headers.get("etag");
  assert.ok(etag);
  await first.text();
  const second = await fetch(`${base(port)}/css/app.css`, { headers: { "if-none-match": etag } });
  assert.equal(second.status, 304);

  const traversal = await fetch(`${base(port)}/%2e%2e/server.js`);
  assert.notEqual(traversal.status, 200);
});

test("games are served", async () => {
  for (const g of ["snake", "2048", "blocks", "breakout", "flappy", "memory", "mines", "clicker"]) {
    const r = await fetch(`${base(port)}/games/${g}.html`);
    assert.equal(r.status, 200, g);
    await r.text();
  }
});

/* ---------------- reader engine ---------------- */

test("reader fetches, rewrites, strips scripts, reports final URL", async () => {
  const res = await fetch(`${base(port)}/api/fetch?mode=reader&url=${encodeURIComponent(fixtureUrl("/page"))}`);
  assert.equal(res.status, 200);
  assert.equal(decodeURIComponent(res.headers.get("x-pine-final-url")), fixtureUrl("/page"));
  const html = await res.text();
  assert.match(html, /Fixture/);
  assert.ok(!html.includes('alert("nope")'));
  assert.ok(html.includes(encodeURIComponent(fixtureUrl("/page2"))));
  assert.ok(html.includes("pine-reader-bar"));
});

test("reader follows redirects and rewrites CSS assets; binaries pass through", async () => {
  const redir = await (await fetch(`${base(port)}/api/fetch?mode=reader&url=${encodeURIComponent(fixtureUrl("/redir"))}`)).text();
  assert.match(redir, /Fixture Page|Fixture/);

  const css = await (await fetch(`${base(port)}/api/fetch?mode=asset&url=${encodeURIComponent(fixtureUrl("/style.css"))}`)).text();
  assert.ok(css.includes(encodeURIComponent(fixtureUrl("/bg.png"))), "css url rewritten");
  assert.ok(css.includes(encodeURIComponent(fixtureUrl("/more.css"))), "css @import rewritten");

  const img = await fetch(`${base(port)}/api/fetch?mode=asset&url=${encodeURIComponent(fixtureUrl("/img.png"))}`);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await img.arrayBuffer()).toString("hex"), "89504e470d0a1a0a");

  const post = await (await fetch(`${base(port)}/api/fetch?mode=reader&url=${encodeURIComponent(fixtureUrl("/echo"))}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "q=pine+trees",
  })).text();
  assert.match(post, /method=POST body=q=pine\+trees/);
});

test("reader on a strict (default) instance blocks private + metadata targets", async () => {
  strictPine = createPineServer({ allowPrivate: false, logLevel: "silent" });
  strictPort = await listen(strictPine.server);
  const local = await fetch(`${base(strictPort)}/api/fetch?mode=reader&url=${encodeURIComponent(fixtureUrl("/page"))}`);
  const body = await local.text();
  assert.ok(local.status === 400 || local.status === 403, `got ${local.status}`);
  assert.match(body, /didn't load/);
  const meta = await fetch(`${base(strictPort)}/api/fetch?mode=reader&url=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`);
  assert.ok(meta.status === 400 || meta.status === 403);
  await meta.text();
});

/* ---------------- small APIs ---------------- */

test("config/stats/suggest/answer return sane JSON offline", async () => {
  const cfg = await (await fetch(`${base(port)}/api/config`)).json();
  assert.deepEqual(cfg.engines, ["scramjet", "reader", "direct"]);
  assert.equal(cfg.defaultTransport, "libcurl");
  const stats = await (await fetch(`${base(port)}/api/stats`)).json();
  assert.ok(typeof stats.uptime === "number" && stats.chat);
  const sug = await (await fetch(`${base(port)}/api/suggest?q=pine`)).json();
  assert.ok(Array.isArray(sug.suggestions));
  const ans = await (await fetch(`${base(port)}/api/answer?q=pine+tree`)).json();
  assert.ok("answer" in ans);
});

/* ---------------- chat ---------------- */

test("chat relays messages and presence between two clients", async () => {
  const mk = () => new WebSocket(`ws://127.0.0.1:${port}/chat`);
  const wait = (ws, pred, ms = 4000) => new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("chat timeout")), ms);
    const onMsg = (d) => {
      let m;
      try { m = JSON.parse(d.toString()); } catch { return; }
      if (pred(m)) { clearTimeout(to); ws.off("message", onMsg); resolve(m); }
    };
    ws.on("message", onMsg);
  });
  const a = mk(), b = mk();
  try {
    await Promise.all([wait(a, (m) => m.t === "hello"), wait(b, (m) => m.t === "hello")]);
    // Attach waiters BEFORE triggering the events they wait for.
    const joinedB = wait(b, (m) => m.t === "joined");
    const presenceP = wait(a, (m) => m.t === "presence" && m.count === 2);
    a.send(JSON.stringify({ t: "join", room: "test-room", name: "alice", color: "#7ee2a8", badge: "leaf" }));
    b.send(JSON.stringify({ t: "join", room: "test-room", name: "bob", color: "#ff0000", badge: "nope" }));
    await joinedB;
    const presence = await presenceP;
    assert.deepEqual(presence.users.map((u) => u.name).sort(), ["alice", "bob"]);
    assert.equal(presence.users.find((u) => u.name === "bob").badge, "none", "invalid badge sanitised");
    const gotP = wait(b, (m) => m.t === "msg");
    a.send(JSON.stringify({ t: "msg", text: "hello bob 🌲" }));
    const got = await gotP;
    assert.equal(got.text, "hello bob 🌲");
    assert.equal(got.name, "alice");
  } finally {
    a.close(); b.close();
  }
});

/* ---------------- wisp end-to-end ---------------- */

test("wisp carries real TCP traffic to the fixture site", async () => {
  // Earlier tests created instances that flipped the process-wide wisp
  // options (a single real deployment has one config) — restore this
  // instance's before dialing loopback.
  configureWisp({ allowPrivate: true, blockHosts: [], dnsServers: [], logLevel: "silent" });
  const { client: wispClient } = await import("@mercuryworkshop/wisp-js/client");
  const conn = new wispClient.ClientConnection(`ws://127.0.0.1:${port}/wisp/`);
  try {
  const responseText = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("wisp timeout")), 8000);
    conn.onopen = () => {
      const stream = conn.create_stream("127.0.0.1", fixturePort);
      const chunks = [];
      stream.onmessage = (data) => {
        chunks.push(Buffer.from(data));
        const all = Buffer.concat(chunks).toString("utf8");
        if (all.includes("hello from upstream")) {
          clearTimeout(to);
          resolve(all);
        }
      };
      stream.onclose = (reason) => {
        const all = Buffer.concat(chunks).toString("utf8");
        if (all) { clearTimeout(to); resolve(all); }
      };
      stream.send(new TextEncoder().encode("GET /hello HTTP/1.0\r\nHost: fixture\r\n\r\n"));
    };
    conn.onerror = (e) => { clearTimeout(to); reject(new Error("wisp error " + e)); };
  });
  assert.match(responseText, /hello from upstream/);
  } finally {
    try { conn.close(); } catch { /* ignore */ }
  }
});

/* ---------------- auth gate ---------------- */

test("PINE_PASS enables basic auth everywhere except healthz", async () => {
  authPine = createPineServer({ authUser: "pine", authPass: "hunter2-is-a-tree", allowPrivate: true, logLevel: "silent" });
  authPort = await listen(authPine.server);
  assert.equal((await fetch(`${base(authPort)}/healthz`)).status, 200);
  assert.equal((await fetch(`${base(authPort)}/`)).status, 401);
  const ok = await fetch(`${base(authPort)}/`, {
    headers: { authorization: "Basic " + Buffer.from("pine:hunter2-is-a-tree").toString("base64") },
  });
  assert.equal(ok.status, 200);
  await ok.text();
  const bad = await fetch(`${base(authPort)}/`, {
    headers: { authorization: "Basic " + Buffer.from("pine:wrong").toString("base64") },
  });
  assert.equal(bad.status, 401);
});
