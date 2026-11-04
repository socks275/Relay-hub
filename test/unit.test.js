import { test } from "node:test";
import assert from "node:assert/strict";

import { parseIPv4, isPrivateIp, validateTarget, TargetError } from "../src/ssrf.js";
import { rewriteHtml, rewriteCss } from "../src/rewrite.js";
import { evaluateMath, convertUnits, formatNumber } from "../public/js/ai.js";

/* ---------------- ssrf: IPv4 notations ---------------- */

test("parseIPv4 handles every inet_aton notation", () => {
  const loop = 0x7f000001;
  assert.equal(parseIPv4("127.0.0.1"), loop);
  assert.equal(parseIPv4("127.1"), loop);
  assert.equal(parseIPv4("0x7f000001"), loop);
  assert.equal(parseIPv4("0x7f.1"), loop);
  assert.equal(parseIPv4("0177.0.0.1"), loop);
  assert.equal(parseIPv4("2130706433"), loop);
  assert.equal(parseIPv4("8.8.8.8"), 0x08080808);
  assert.equal(parseIPv4("example.com"), null);
  assert.equal(parseIPv4("999.1.1.1"), null);
  assert.equal(parseIPv4("1.2.3.4.5"), null);
});

test("isPrivateIp catches private, loopback, metadata, mapped + NAT64", () => {
  for (const ip of [
    "127.0.0.1", "10.0.0.5", "172.16.4.4", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "0.0.0.0", "100.64.1.1", "198.18.0.1", "224.0.0.1",
    "::1", "fe80::1", "fd00::1", "fc12:3456::1", "::ffff:127.0.0.1",
    "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "2001:db8::1",
  ]) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "93.184.215.14"])
    assert.equal(isPrivateIp(ip), false, ip);
  assert.equal(isPrivateIp("nonsense"), true, "unknown formats fail closed");
});

test("validateTarget enforces scheme, ports, reserved hosts, literals", () => {
  assert.ok(validateTarget("https://example.com/page"));
  assert.throws(() => validateTarget("file:///etc/passwd"), TargetError);
  assert.throws(() => validateTarget("https://example.com:22/"), TargetError);
  assert.throws(() => validateTarget("http://metadata.google.internal/"), TargetError);
  assert.throws(() => validateTarget("http://printer.local/"), TargetError);
  assert.throws(() => validateTarget("http://127.0.0.1/"), TargetError);
  assert.throws(() => validateTarget("http://0x7f000001/"), TargetError);
  assert.throws(() => validateTarget("http://[::1]/"), TargetError);
  assert.throws(() => validateTarget("https://user:pass@example.com/"), TargetError);
  // allowPrivate relaxes everything (trusted-LAN mode):
  assert.ok(validateTarget("http://127.0.0.1:8080/x", { allowPrivate: true }));
});

/* ---------------- rewrite (reader) ---------------- */

const BASE = "https://example.com/dir/page.html";

test("rewriteHtml strips scripts and rewrites links/assets/forms", () => {
  const html = `<!doctype html><html><head><title>T</title>
    <script src="/evil.js">alert(1)</script>
    <link rel="stylesheet" href="s.css">
    <style>.a{background:url(img/bg.png)}</style></head>
    <body onclick="hack()">
      <a href="/next">next</a>
      <a href="https://other.site/x">other</a>
      <img src="pic.jpg" srcset="small.jpg 480w, big.jpg 1024w">
      <form action="/submit"><input name="q"></form>
      <iframe src="https://ads.example/"></iframe>
    </body></html>`;
  const out = rewriteHtml(html, BASE);
  assert.ok(!out.includes("evil.js") && !out.includes("<script"), "scripts gone");
  assert.ok(!out.includes("onclick"), "handlers gone");
  assert.ok(!out.includes("ads.example"), "iframes gone");
  assert.ok(out.includes(encodeURIComponent("https://example.com/next")), "page link proxied");
  assert.ok(out.includes("mode=reader"), "reader mode for navigation");
  assert.ok(out.includes(encodeURIComponent("https://example.com/dir/pic.jpg")), "relative img resolved");
  assert.ok(out.includes(encodeURIComponent("https://example.com/dir/small.jpg")), "srcset rewritten");
  assert.ok(out.includes(encodeURIComponent("https://example.com/dir/img/bg.png")), "style url() rewritten");
  assert.ok(out.includes(encodeURIComponent("https://example.com/submit")), "form action rewritten");
  assert.ok(out.includes("pine-reader-bar"), "reader bar injected");
});

test("rewriteHtml honours <base> and meta refresh; unwraps DDG redirects", () => {
  const html = `<head><base href="https://cdn.example.org/assets/">
    <meta http-equiv="refresh" content="5; url=https://example.com/landing"></head>
    <body><img src="logo.png">
    <a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Freal.destination%2Fpage">result</a></body>`;
  const out = rewriteHtml(html, BASE);
  assert.ok(out.includes(encodeURIComponent("https://cdn.example.org/assets/logo.png")), "base applied");
  assert.ok(!out.includes("<base"), "base removed");
  assert.ok(out.includes(encodeURIComponent("https://example.com/landing")), "meta refresh stays in reader");
  assert.ok(out.includes(encodeURIComponent("https://real.destination/page")), "ddg /l/ unwrapped");
});

test("rewriteCss rewrites url() and @import", () => {
  const out = rewriteCss(`@import "theme.css"; .a{background:url('../img.png')}`, "https://ex.com/css/main.css");
  assert.ok(out.includes(encodeURIComponent("https://ex.com/css/theme.css")));
  assert.ok(out.includes(encodeURIComponent("https://ex.com/img.png")));
});

test("rewriteHtml survives '>' inside attribute values", () => {
  const out = rewriteHtml(`<body><a title="a > b" href="/deep">x</a><img alt="2 > 1" src="p.png"></body>`, BASE);
  assert.ok(out.includes(encodeURIComponent("https://example.com/deep")), "href after quoted > still rewritten");
  assert.ok(out.includes(encodeURIComponent("https://example.com/dir/p.png")), "src after quoted > still rewritten");
  assert.ok(out.includes('title="a > b"'), "quoted attribute left intact");
});

test("rewriteHtml preserves data: URIs in srcset and proxifies the rest", () => {
  const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const out = rewriteHtml(`<body><img srcset="${dataUri} 1x, real.png 2x"></body>`, BASE);
  assert.ok(out.includes(dataUri), "data URI (with its comma) untouched");
  assert.ok(out.includes(encodeURIComponent("https://example.com/dir/real.png")), "sibling candidate proxied");
});

test("rewriteHtml neutralises javascript:/vbscript: links", () => {
  const out = rewriteHtml(`<body><a href="JaVaScRiPt:alert(1)">a</a><a href=" vbscript:msgbox(1)">b</a></body>`, BASE);
  assert.ok(!/javascript:/i.test(out) && !/vbscript:/i.test(out), "no script schemes survive");
  assert.ok(out.includes('href="#"'), "replaced with inert fragment");
});

test("rewriteHtml handles meta refresh without a delay number", () => {
  const out = rewriteHtml(`<head><meta http-equiv="refresh" content="url=https://example.com/land"></head>`, BASE);
  assert.ok(out.includes(encodeURIComponent("https://example.com/land")), "delayless refresh stays in reader");
});

test("rewriteHtml unwraps Bing /ck/ with URL-safe unpadded base64", () => {
  const dest = "https://dest.example/landing?from=bing&x=1";
  const b64 = Buffer.from(dest).toString("base64url"); // url-safe alphabet, no padding
  const out = rewriteHtml(`<body><a href="https://www.bing.com/ck/a?u=a1${b64}&ntb=1">r</a></body>`, BASE);
  assert.ok(out.includes(encodeURIComponent(dest)), "bing destination decoded");
  assert.ok(!out.includes("bing.com"), "tracker URL gone");
});

/* ---------------- AI maths ---------------- */

test("evaluateMath parses arithmetic, powers, functions, factorials", () => {
  assert.equal(evaluateMath("2+3*4"), 14);
  assert.equal(evaluateMath("(2+3)*4"), 20);
  assert.equal(evaluateMath("2^10"), 1024);
  assert.equal(evaluateMath("sqrt(144) + 3^4"), 93);
  assert.equal(evaluateMath("15% of 230"), 34.5);
  assert.equal(evaluateMath("7!"), 5040);
  assert.equal(evaluateMath("10 % 3"), 1);
  assert.equal(evaluateMath("-5 + 3"), -2);
  assert.ok(Math.abs(evaluateMath("sin(pi/2)") - 1) < 1e-12);
  assert.equal(evaluateMath("2(3+4)"), 14, "implicit multiplication");
  assert.equal(evaluateMath("50%"), 0.5);
  assert.equal(evaluateMath("not maths at all"), null);
  assert.equal(evaluateMath("1/0"), null, "non-finite rejected");
  assert.equal(evaluateMath("2+"), null);
});

test("convertUnits handles length, mass, temperature, time", () => {
  assert.match(convertUnits("5 km to miles").text, /3\.106/);
  assert.match(convertUnits("72f to c").text, /22\.22/);
  assert.match(convertUnits("100c to f").text, /212/);
  assert.match(convertUnits("2 hours to minutes").text, /120/);
  assert.match(convertUnits("10 kg to lbs").text, /22\.046/);
  assert.equal(convertUnits("5 parsecs to bananas"), null);
  assert.equal(formatNumber(1234567), "1,234,567");
});

/* ---------------- built-in games ---------------- */

test("every built-in game's inline script compiles", async () => {
  const { readFile } = await import("node:fs/promises");
  const { Script } = await import("node:vm");
  for (const g of ["snake", "2048", "blocks", "breakout", "flappy", "memory", "mines", "clicker"]) {
    const html = await readFile(new URL(`../public/games/${g}.html`, import.meta.url), "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 1, `${g} has an inline script`);
    for (const code of scripts) new Script(code, { filename: `${g}.html` }); // throws on syntax error
    assert.match(html, /pineCoins|postMessage/, `${g} pays out coins`);
  }
});

/* ---------------- URL normalisation (client proxy utils) ---------------- */

test("normaliseInput distinguishes URLs, hosts, searches and bangs", async () => {
  globalThis.location = { protocol: "http:", host: "localhost:3000", href: "http://localhost:3000/" };
  const { normaliseInput, looksLikeHost, urlFromReaderLocation } = await import("../public/js/proxy.js");
  assert.equal(normaliseInput("https://example.com/x"), "https://example.com/x");
  assert.equal(normaliseInput("example.com/x"), "https://example.com/x");
  assert.equal(normaliseInput("en.wikipedia.org/wiki/Pine"), "https://en.wikipedia.org/wiki/Pine");
  assert.ok(normaliseInput("how do trees work").includes("duckduckgo.com"));
  assert.ok(normaliseInput("how do trees work").includes(encodeURIComponent("how do trees work")));
  assert.ok(normaliseInput("!yt lo-fi beats").startsWith("https://www.youtube.com/results"));
  assert.ok(normaliseInput("cats", "google").startsWith("https://www.google.com/search"));
  assert.equal(looksLikeHost("localhost:8080/x"), true);
  assert.equal(looksLikeHost("just some words"), false);
  assert.equal(looksLikeHost("a.b"), false, "needs a real TLD");
  assert.equal(
    urlFromReaderLocation("http://localhost:3000/api/fetch?mode=reader&url=" + encodeURIComponent("https://ex.com/a")),
    "https://ex.com/a"
  );
});
