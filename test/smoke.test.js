/* Browser-smoke test (jsdom) — boots the real Pine hub in a DOM, clicks
 * through every view, asks the AI, opens a game, opens the shop, and browses
 * a fixture site via the Reader fallback (jsdom has no service workers, so
 * this also exercises the graceful-degradation path). Any uncaught page
 * error fails the test. */
import http from "node:http";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import { build } from "esbuild";
import { createPineServer } from "../server.js";

// jsdom cannot run <script type="module">, so bundle the real client to a
// classic script and inject it after page load. Same code, same bugs.
const bundle = await build({
  entryPoints: ["public/js/app.js"],
  bundle: true, format: "iife", platform: "browser", write: false, logLevel: "silent",
});
const bundleCode = bundle.outputFiles[0].text;

const fixture = http.createServer((req, res) => {
  if (req.url === "/page") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<!doctype html><title>Fixture Title</title><h1>Fixture Heading</h1><p>body text</p>");
  }
  res.writeHead(404); res.end();
});
await new Promise(r => fixture.listen(0, "127.0.0.1", r));
const fixturePort = fixture.address().port;

const pine = createPineServer({ allowPrivate: true, logLevel: "silent" });
await new Promise(r => pine.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${pine.server.address().port}/`;
console.log("pine at", base, "fixture port", fixturePort);

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => {
  const s = String(e.detail?.stack || e.detail?.message || e.message || e);
  if (/Not implemented/.test(s)) return; // jsdom gaps, stubbed below anyway
  errors.push(s.split("\n").slice(0, 3).join("\n"));
});
vc.on("error", (m) => errors.push("console.error: " + m));

const dom = await JSDOM.fromURL(base, {
  resources: "usable",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.scrollTo = () => {};
    window.fetch = (u, o) => fetch(new URL(u, base), o);
    // seen intro + a name, so boot goes straight to the hub
    window.localStorage.setItem("pine.v1", JSON.stringify({
      settings: { engine: "scramjet" },
      profile: { name: "smoke" },
      wallet: { coins: 150, xp: 0, owned: [], lastDaily: "2000-1-1" },
      history: [], bookmarks: [], seenIntro: true,
    }));
  },
});
const w = dom.window;
{
  const s = w.document.createElement("script");
  s.textContent = bundleCode;
  w.document.body.appendChild(s);
}
const $ = (s, r = w.document) => r.querySelector(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms = 9000) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < ms) {
    try { const v = fn(); if (v) return v; } catch (e) { lastErr = e; }
    await sleep(120);
  }
  throw new Error("TIMEOUT waiting: " + label + (lastErr ? " (" + lastErr.message + ")" : ""));
}
let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failed++;
};

try {
  // 1. Boot
  await waitFor(() => $("#quick-grid").children.length >= 8, "quick grid renders");
  check("boot: quick launch rendered", true);
  check("boot: greeting mentions name", /smoke/.test($("#greeting").textContent), $("#greeting").textContent);
  check("boot: coins chip shows balance", $("#coins-count").textContent.includes("150"));
  check("boot: study cards rendered", $("#study-grid").children.length === 6);
  check("boot: title is disguised", /Student Practice Center/.test(w.document.title));

  // 2. Daily claim
  $("#daily-btn").click();
  await sleep(150);
  check("daily claim pays 250", $("#coins-count").textContent.includes("400"), $("#coins-count").textContent);
  check("daily button disables after claim", $("#daily-btn").disabled === true);

  // 3. View switching + catalogues
  w.document.querySelector('.rail-btn[data-view="play"]').click();
  await sleep(100);
  check("play: grid has games", $("#play-grid").children.length >= 20, String($("#play-grid").children.length));
  $("#play-search").value = "snake";
  $("#play-search").dispatchEvent(new w.Event("input", { bubbles: true }));
  await sleep(100);
  check("play: search filters", $("#play-grid").children.length >= 1 && $("#play-grid").children.length <= 3, String($("#play-grid").children.length));

  // 4. Open Memory game (DOM game; canvas games can't run in jsdom)
  $("#play-search").value = "memory";
  $("#play-search").dispatchEvent(new w.Event("input", { bubbles: true }));
  await sleep(100);
  $("#play-grid").children[0].click();
  await waitFor(() => !$("#game-overlay").hidden, "game overlay opens");
  const gameDoc = await waitFor(() => {
    const d = $("#game-frame").contentDocument;
    return d && d.querySelectorAll(".card").length === 16 ? d : null;
  }, "memory board deals 16 cards", 12000);
  check("game: memory deals cards in overlay iframe", !!gameDoc);
  // flip two cards
  const cards = [...gameDoc.querySelectorAll(".card")];
  cards[0].click();
  await sleep(50);
  check("game: card flips", cards[0].classList.contains("open"));
  $("#game-close").click();
  check("game: overlay closes", $("#game-overlay").hidden === true);

  // 5. Apps filter
  w.document.querySelector('.rail-btn[data-view="apps"]').click();
  await sleep(100);
  check("apps: grid renders 44", $("#apps-grid").children.length === 44, String($("#apps-grid").children.length));

  // 6. AI maths + conversion
  w.document.querySelector('.rail-btn[data-view="ai"]').click();
  await sleep(100);
  $("#ai-input").value = "17 * 24 + sqrt(81)";
  $("#ai-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => [...w.document.querySelectorAll(".ai-msg.bot")].some(el => el.textContent.includes("417")), "AI answers maths");
  check("ai: computes 17*24+sqrt(81)=417", true);
  $("#ai-input").value = "10 kg to lbs";
  $("#ai-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => [...w.document.querySelectorAll(".ai-msg.bot")].some(el => el.textContent.includes("22.046")), "AI converts units");
  check("ai: converts units", true);

  // 7. Listen stations render (don't press play — no AudioContext in jsdom)
  w.document.querySelector('.rail-btn[data-view="listen"]').click();
  await sleep(100);
  check("listen: 6 stations + services", $("#stations-grid").children.length === 6 && $("#listen-grid").children.length === 10);

  // 8. Watch renders
  w.document.querySelector('.rail-btn[data-view="watch"]').click();
  await sleep(100);
  check("watch: services render", $("#watch-grid").children.length === 16);

  // 9. Settings render (all selects populated)
  w.document.querySelector('.rail-btn[data-view="settings"]').click();
  await sleep(250);
  check("settings: search engines populated", $("#set-search").options.length >= 8);
  check("settings: cloaks populated", $("#set-cloak").options.length >= 9);
  check("settings: themes populated", $("#set-theme").options.length === 5);
  check("settings: avatars populated", $("#set-avatars").children.length >= 10);

  // 10. Browse the fixture site from Home omnibox → Scramjet unavailable in
  //     jsdom (no SW) → should gracefully fall back to Reader and load it.
  w.document.querySelector('.rail-btn[data-view="home"]').click();
  await sleep(100);
  $("#home-input").value = `http://127.0.0.1:${fixturePort}/page`;
  $("#home-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => w.document.querySelector('.view.active')?.dataset.view === "browse", "switches to browse view");
  check("browse: view activates + tab created", w.document.querySelectorAll(".tab").length === 1);
  const readDoc = await waitFor(() => {
    const f = w.document.querySelector("#frames iframe");
    const d = f?.contentDocument;
    return d && d.body?.textContent.includes("Fixture Heading") ? d : null;
  }, "reader fallback loads fixture page", 15000);
  check("browse: reader fallback shows proxied page", !!readDoc);
  await waitFor(() => $("#addr-input").value.includes(`/page`), "address bar syncs");
  check("browse: address bar synced", true);
  await waitFor(() => $(".tab-title")?.textContent.includes("Fixture"), "tab title syncs from reader");
  check("browse: tab title synced", true, $(".tab-title")?.textContent);
  check("browse: engine select reflects Reader fallback", $("#engine-sel").value === "reader", $("#engine-sel").value);

  // 11. Bookmark toggle
  $("#nav-star").click();
  await sleep(100);
  check("browse: bookmark star toggles on", $("#nav-star").classList.contains("on"));

  // 12. New tab + close tab
  $("#tab-add").click();
  await sleep(100);
  check("tabs: second tab opens", w.document.querySelectorAll(".tab").length === 2);
  w.document.querySelector("[data-close]")?.click();
  await sleep(100);
  check("tabs: close removes a tab", w.document.querySelectorAll(".tab").length === 1);

  // 13. Pro/shop modal opens and renders items
  $("#pro-btn").click();
  await waitFor(() => w.document.querySelectorAll(".shop-item").length >= 9, "shop renders");
  check("shop: items + pro section render", true);
  w.document.querySelector("[data-close-modal]")?.click();
  await sleep(80);
  check("shop: modal closes", !w.document.querySelector("#modal-back"));
} catch (e) {
  failed++;
  console.log("HARNESS ERROR:", e.message);
}

console.log("\n--- page errors captured:", errors.length);
for (const e of errors.slice(0, 8)) console.log("  •", e);
console.log(failed ? `\nRESULT: ${failed} failures` : "\nRESULT: all smoke checks passed");

// The walkthrough above ran at module load (top-level await); this test is
// its verdict. Timeout is generous for slow CI machines.
test("browser smoke: full hub walkthrough, zero page errors", { timeout: 120000 }, () => {
  assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
  assert.equal(failed, 0, `${failed} smoke checks failed (see log above)`);
});

after(() => {
  try { dom.window.close(); } catch {}
  pine.chat.close(); pine.server.closeAllConnections?.(); pine.server.close();
  fixture.closeAllConnections?.(); fixture.close();
});
