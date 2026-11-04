/* Relay Hub — build test.
 *
 * Runs the real build into a temporary directory and inspects the output.
 * This is what catches "the deploy would have shipped a broken 404 page"
 * class of bug, which unit tests on individual functions cannot see.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { build, BUNDLE_FILES } from "../scripts/build.mjs";

async function buildToTemp(env = {}) {
  const outDir = await mkdtemp(path.join(tmpdir(), "relay-build-"));
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const result = await build({ outDir });
    return { ...result, outDir };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const read = (dir, file) => readFile(path.join(dir, file), "utf8");

test("the build produces a complete, self-contained site", async (t) => {
  const { outDir } = await buildToTemp({ GITHUB_REPOSITORY: "socks275/Relay-hub" });
  t.after(() => rm(outDir, { recursive: true, force: true }));

  for (const file of [
    "index.html",
    "404.html",
    "sw.js",
    "manifest.webmanifest",
    "favicon.svg",
    "css/app.css",
    "js/app.js",
    "js/engine.js",
    "js/simple.js",
    "js/rewrite.js",
    "js/urls.js",
    "js/data.js",
    "js/store.js",
    "relay-config.js",
    ...BUNDLE_FILES.map(([, to]) => to),
  ]) {
    await assert.doesNotReject(read(outDir, file), `${file} should be in the build`);
  }

  // Pages needs this or it ignores files and directories starting with _.
  await assert.doesNotReject(read(outDir, ".nojekyll"));
});

test("the build wires relay-config.js ahead of the app module", async (t) => {
  const { outDir } = await buildToTemp({ GITHUB_REPOSITORY: "socks275/Relay-hub" });
  t.after(() => rm(outDir, { recursive: true, force: true }));

  const html = await read(outDir, "index.html");
  const configAt = html.indexOf("relay-config.js");
  const appAt = html.indexOf("js/app.js");
  assert.ok(configAt !== -1, "relay-config.js is injected");
  assert.ok(appAt !== -1, "the app module is still there");
  assert.ok(configAt < appAt, "config must load before the app");

  const config = await read(outDir, "relay-config.js");
  assert.match(config, /window\.RELAY_WISP = \[/);
  assert.match(config, /wss:\/\//);
});

test("404.html gets the real site URL, everywhere", async (t) => {
  const { outDir } = await buildToTemp({ GITHUB_REPOSITORY: "socks275/Relay-hub" });
  t.after(() => rm(outDir, { recursive: true, force: true }));

  const html = await read(outDir, "404.html");
  assert.doesNotMatch(html, /__BASE__/, "no placeholder may survive the build");
  assert.equal(
    (html.match(/https:\/\/socks275\.github\.io\/Relay-hub\//g) || []).length,
    2,
    "both the comment and the script get the URL",
  );
  assert.match(html, /var base = "https:\/\/socks275\.github\.io\/Relay-hub\/";/);
});

test("a custom domain wins over the Pages URL", async (t) => {
  const { outDir, siteUrl } = await buildToTemp({
    GITHUB_REPOSITORY: "socks275/Relay-hub",
    RELAY_BASE_URL: "https://relay.example.com",
  });
  t.after(() => rm(outDir, { recursive: true, force: true }));

  assert.equal(siteUrl, "https://relay.example.com/");
  assert.match(await read(outDir, "404.html"), /var base = "https:\/\/relay\.example\.com\/";/);
});

test("the Wisp pool can be overridden by environment", async (t) => {
  const { outDir, wisp } = await buildToTemp({
    RELAY_WISP: "wss://one.example/, wss://two.example/wisp",
  });
  t.after(() => rm(outDir, { recursive: true, force: true }));

  assert.deepEqual(wisp, ["wss://one.example/", "wss://two.example/wisp/"]);
  assert.match(await read(outDir, "relay-config.js"), /wss:\/\/one\.example\//);
});

test("the built site uses relative URLs so it works under any subpath", async (t) => {
  const { outDir } = await buildToTemp({ GITHUB_REPOSITORY: "socks275/Relay-hub" });
  t.after(() => rm(outDir, { recursive: true, force: true }));

  const sources = ["index.html", "manifest.webmanifest"];
  for (const file of sources) {
    const text = await read(outDir, file);
    // Absolute paths would escape a project site served from /<repo>/.
    assert.doesNotMatch(text, /(?:href|src|start_url|scope)":? *"\/(?!\/)/, `${file} must not hard-code root paths`);
  }
});
