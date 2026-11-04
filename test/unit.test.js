/* Relay Hub — unit tests.
 *
 * These cover the parts that can be reasoned about without a browser: URL
 * resolution, HTML rewriting for Simple mode, and the build's config
 * plumbing. Run with `npm test`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  looksLikeHost,
  normaliseInput,
  normaliseWispUrl,
  resolveBase,
  appUrl,
  hostOf,
  prettyUrl,
  sameUrl,
  safeUrl,
} from "../site/js/urls.js";
import { absolutise, rewriteHtml, runtimeScript } from "../site/js/rewrite.js";
import { BANGS, SEARCH_ENGINES, QUICK_LINKS, CLOAK_PRESETS } from "../site/js/data.js";
import { normaliseWisp, wispFromEnv, siteUrlFromEnv } from "../scripts/build.mjs";

/* ------------------------------------------------------------------ URLs */

test("looksLikeHost separates hostnames from search terms", () => {
  assert.equal(looksLikeHost("example.com"), true);
  assert.equal(looksLikeHost("sub.example.co.uk/path"), true);
  assert.equal(looksLikeHost("localhost:3000"), true);
  assert.equal(looksLikeHost("192.168.0.1"), true);
  assert.equal(looksLikeHost("what is the weather"), false);
  assert.equal(looksLikeHost("hello"), false);
  assert.equal(looksLikeHost(""), false);
});

test("normaliseInput handles URLs, hosts, bangs and searches", () => {
  const opts = { search: "duckduckgo", engines: SEARCH_ENGINES, bangs: BANGS };
  assert.equal(normaliseInput("https://example.com/a?b=1", opts), "https://example.com/a?b=1");
  assert.equal(normaliseInput("example.com", opts), "https://example.com/");
  assert.equal(normaliseInput("  ", opts), "");
  assert.equal(
    normaliseInput("!yt lo-fi beats", opts),
    "https://www.youtube.com/results?search_query=lo-fi%20beats",
  );
  assert.equal(
    normaliseInput("cats", opts),
    "https://duckduckgo.com/?q=cats",
  );
  assert.equal(
    normaliseInput("cats", { ...opts, search: "google" }),
    "https://www.google.com/search?q=cats",
  );
});

test("normaliseInput ignores unknown bangs", () => {
  const opts = { search: "duckduckgo", engines: SEARCH_ENGINES, bangs: BANGS };
  assert.equal(
    normaliseInput("!definitelynotabang cats", opts),
    "https://duckduckgo.com/?q=!definitelynotabang%20cats",
  );
});

test("normaliseWispUrl adds a scheme and trailing slash", () => {
  assert.equal(normaliseWispUrl("wisp.example.com"), "wss://wisp.example.com/");
  assert.equal(normaliseWispUrl("wss://wisp.example.com/wisp"), "wss://wisp.example.com/wisp/");
  assert.equal(normaliseWispUrl("ws://localhost:8080"), "ws://localhost:8080/");
  assert.equal(normaliseWispUrl(""), "");
  assert.equal(normaliseWispUrl("http://nope.example"), "");
  assert.equal(normaliseWispUrl("not a url at all"), "");
});

test("base paths work at the domain root and under a project subpath", () => {
  assert.equal(resolveBase("https://user.github.io/"), "/");
  assert.equal(resolveBase("https://user.github.io/Relay-hub/"), "/Relay-hub/");
  assert.equal(resolveBase("https://user.github.io/Relay-hub/index.html"), "/Relay-hub/");
  assert.equal(resolveBase(undefined), "/");
});

test("safeUrl rejects non-http schemes", () => {
  assert.equal(safeUrl("https://example.com")?.host, "example.com");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html,x"), null);
  assert.equal(safeUrl(""), null);
});

test("hostOf, prettyUrl and sameUrl are forgiving", () => {
  assert.equal(hostOf("https://www.example.com/x"), "example.com");
  assert.equal(hostOf("nonsense"), "");
  assert.equal(prettyUrl("https://example.com/a/b?c=1"), "example.com/a/b?c=1");
  assert.equal(sameUrl("https://example.com/a/", "https://example.com/a"), true);
  assert.equal(sameUrl("https://example.com/a", "https://example.com/b"), false);
});

/* -------------------------------------------------------------- rewriting */

test("absolutise resolves relative URLs and leaves others alone", () => {
  const base = "https://example.com/a/b?x=1";
  assert.equal(absolutise("c.png", base), "https://example.com/a/c.png");
  assert.equal(absolutise("/root.png", base), "https://example.com/root.png");
  assert.equal(absolutise("//cdn.example/x.png", base), "https://cdn.example/x.png");
  assert.equal(absolutise("#frag", base), "#frag");
  assert.equal(absolutise("data:image/png;base64,AAA", base), "data:image/png;base64,AAA");
  assert.equal(absolutise("javascript:void(0)", base), "javascript:void(0)");
  assert.equal(absolutise("", base), "");
});

test("rewriteHtml absolutises links, images and forms", () => {
  const html = `<html><head><title>t</title></head><body>
    <a href="/next">next</a>
    <img src="pic.png">
    <form action="search" method="get"><input name="q"></form>
    <script src="/app.js"></script>
  </body></html>`;
  const out = rewriteHtml(html, "https://example.com/a/b", { runtime: "" });
  assert.match(out, /<base href="https:\/\/example\.com\/a\/b">/);
  assert.match(out, /href="https:\/\/example\.com\/next"/);
  assert.match(out, /src="https:\/\/example\.com\/a\/pic\.png"/);
  assert.match(out, /action="https:\/\/example\.com\/a\/search"/);
  assert.match(out, /src="https:\/\/example\.com\/app\.js"/);
});

test("rewriteHtml strips CSP meta tags and SRI hashes", () => {
  const html = `<head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'">
    <script src="https://cdn.example/a.js" integrity="sha384-abc"></script>
  </head>`;
  const out = rewriteHtml(html, "https://example.com/", { runtime: "" });
  assert.doesNotMatch(out, /content-security-policy/i);
  assert.doesNotMatch(out, /integrity=/i);
  assert.match(out, /src="https:\/\/cdn\.example\/a\.js"/);
});

test("rewriteHtml handles srcset, inline styles and style blocks", () => {
  const html = `<img srcset="a.png 1x, b.png 2x" alt="">
    <div style="background:url(img/x.png)"></div>
    <style>.a{background:url(img/y.png)}</style>`;
  const out = rewriteHtml(html, "https://example.com/p/", { runtime: "" });
  assert.match(out, /srcset="https:\/\/example\.com\/p\/a\.png 1x, https:\/\/example\.com\/p\/b\.png 2x"/);
  assert.match(out, /url\(https:\/\/example\.com\/p\/img\/x\.png\)/);
  assert.match(out, /url\(https:\/\/example\.com\/p\/img\/y\.png\)/);
});

test("rewriteHtml survives dollar signs in URLs", () => {
  const html = `<a href="/p?a=$1&$2">x</a>`;
  const out = rewriteHtml(html, "https://example.com/", { runtime: "" });
  assert.match(out, /href="https:\/\/example\.com\/p\?a=\$1&\$2"/);
});

test("rewriteHtml injects the head when a document has none", () => {
  const out = rewriteHtml("<p>hi</p>", "https://example.com/", { runtime: "window.__x=1;" });
  assert.match(out, /<base href="https:\/\/example\.com\/">/);
  assert.match(out, /window\.__x=1;/);
});

test("the injected runtime reports navigation instead of following it", () => {
  const src = runtimeScript();
  assert.match(src, /postMessage/);
  assert.match(src, /t: "nav"/);
  assert.match(src, /window\.fetch =/);
  assert.doesNotMatch(src, /<\/script/i); // must never close the host script tag
});

/* ------------------------------------------------------------------ data */

test("every search engine and bang has a substitution slot", () => {
  for (const [key, engine] of Object.entries(SEARCH_ENGINES)) {
    assert.ok(engine.url.includes("%s"), `${key} is missing %s`);
    assert.ok(engine.url.startsWith("https://"), `${key} must be https`);
  }
  for (const [key, bang] of Object.entries(BANGS)) {
    assert.ok(bang.includes("%s"), `!${key} is missing %s`);
  }
});

test("quick links and cloak presets are well formed", () => {
  assert.ok(QUICK_LINKS.length >= 8);
  for (const link of QUICK_LINKS) {
    assert.ok(link.url.startsWith("https://"), `${link.name} must be https`);
    assert.ok(link.icon && link.color);
  }
  assert.equal(CLOAK_PRESETS[0].id, "none");
  for (const preset of CLOAK_PRESETS) assert.ok(preset.title && preset.icon);
});

/* ----------------------------------------------------------------- build */

test("build config reads the Wisp pool from the environment", () => {
  assert.deepEqual(wispFromEnv({}), [
    "wss://wisp.webmc.fun/",
    "wss://wisp.freewisp.org/",
    "wss://wisp.mercurywork.shop/",
    "wss://wisp.terbiumon.top/wisp/",
    "wss://anura.pro/",
  ]);
  assert.deepEqual(wispFromEnv({ RELAY_WISP: "wss://a.example/, wss://b.example" }), [
    "wss://a.example/",
    "wss://b.example/",
  ]);
  assert.equal(normaliseWisp("wss://x.example"), "wss://x.example/");
  assert.throws(() => normaliseWisp("http://x.example"), /Invalid Wisp URL/);
});

test("siteUrlFromEnv derives the Pages URL from GITHUB_REPOSITORY", () => {
  assert.equal(
    siteUrlFromEnv({ GITHUB_REPOSITORY: "socks275/Relay-hub" }),
    "https://socks275.github.io/Relay-hub/",
  );
  assert.equal(siteUrlFromEnv({ RELAY_BASE_URL: "https://relay.example.com" }), "https://relay.example.com/");
  assert.equal(siteUrlFromEnv({}), "");
});

test("appUrl joins paths onto the current base", () => {
  assert.equal(appUrl("sw.js"), "/sw.js");
});
