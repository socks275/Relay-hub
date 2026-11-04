/* Relay Hub — the browser shell: tabs, navigation, settings, cloaking.
 *
 * Design notes:
 *  - The Scramjet engine is ~10 MB of WASM, so it is *not* loaded on page
 *    load. The new-tab page appears instantly and the engine boots on the
 *    first navigation, with progress shown in the address bar area.
 *  - Every tab owns one iframe. A Scramjet tab and a Simple tab use
 *    different iframe shapes (Simple is sandboxed with srcdoc), so switching
 *    engine rebuilds the tab's surface.
 *  - Nothing here talks to a Relay Hub server, because there isn't one.
 */
import { engine } from "./engine.js";
import { SimpleFrame } from "./simple.js";
import { settings, bookmarks } from "./store.js";
import { appUrl, normaliseInput, faviconFor, prettyUrl, hostOf, safeUrl } from "./urls.js";
import { SEARCH_ENGINES, BANGS, QUICK_LINKS, CLOAK_PRESETS, THEMES } from "./data.js";

const $ = (id) => document.getElementById(id);
const dom = {
  boot: $("boot"),
  bootStatus: $("boot-status"),
  chrome: $("chrome"),
  tabs: $("tabs"),
  newTab: $("new-tab"),
  back: $("nav-back"),
  forward: $("nav-forward"),
  reload: $("nav-reload"),
  home: $("nav-home"),
  omnibox: $("omnibox"),
  omniClear: $("omni-clear"),
  omniIcon: $("omni-icon"),
  suggest: $("suggest"),
  star: $("btn-star"),
  blank: $("btn-blank"),
  settingsBtn: $("btn-settings"),
  views: $("views"),
  progress: $("progress"),
  banner: $("banner"),
  bannerText: $("banner-text"),
  bannerAction: $("banner-action"),
  bannerClose: $("banner-close"),
  drawer: $("settings"),
  drawerClose: $("settings-close"),
  panic: $("panic"),
};

const state = {
  tabs: [],
  activeId: null,
  seq: 0,
  enginePromise: null,
  panicked: false,
  suggestItems: [],
  suggestIndex: -1,
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function cloakPreset() {
  const id = settings.get("cloak");
  return CLOAK_PRESETS.find((c) => c.id === id) || CLOAK_PRESETS[0];
}

function applyCloak() {
  const preset = cloakPreset();
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = preset.icon;
  if (!state.panicked) document.title = preset.title;
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.get("theme");
}

let bannerTimer = null;
function banner(message, { kind = "", action = null, timeout = 0 } = {}) {
  dom.banner.hidden = false;
  dom.banner.className = `banner ${kind}`.trim();
  dom.bannerText.textContent = message;
  clearTimeout(bannerTimer);
  if (action) {
    dom.bannerAction.hidden = false;
    dom.bannerAction.textContent = action.label;
    dom.bannerAction.onclick = () => {
      hideBanner();
      action.run();
    };
  } else {
    dom.bannerAction.hidden = true;
    dom.bannerAction.onclick = null;
  }
  if (timeout) bannerTimer = setTimeout(hideBanner, timeout);
}
function hideBanner() {
  dom.banner.hidden = true;
  clearTimeout(bannerTimer);
}
dom.bannerClose.addEventListener("click", hideBanner);

function progress(on) {
  dom.progress.hidden = !on;
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function makeTab() {
  const id = `t${++state.seq}`;
  const view = document.createElement("div");
  view.className = "view";
  view.dataset.tab = id;
  dom.views.appendChild(view);
  const tab = {
    id,
    view,
    url: "",
    title: "New tab",
    favicon: "",
    mode: "idle", // idle | ntp | scramjet | simple
    frame: null,
    simple: null,
    iframe: null,
    ntp: null,
    stack: [],
    stackIndex: -1,
    activity: Date.now(),
    watchdog: null,
    lastError: null,
  };
  state.tabs.push(tab);
  return tab;
}

function tabById(id) {
  return state.tabs.find((t) => t.id === id) || null;
}
function activeTab() {
  return tabById(state.activeId);
}

function activate(id) {
  const tab = tabById(id);
  if (!tab) return;
  state.activeId = id;
  for (const t of state.tabs) t.view.classList.toggle("active", t.id === id);
  renderTabs();
  if (state.panicked) togglePanic(false);
  syncChrome();
  hideSuggest();
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = state.tabs.splice(idx, 1);
  teardown(tab);
  tab.view.remove();
  if (!state.tabs.length) {
    const fresh = makeTab();
    activate(fresh.id);
    renderNewTab(fresh);
    return;
  }
  if (state.activeId === id) activate(state.tabs[Math.min(idx, state.tabs.length - 1)].id);
  else renderTabs();
}

function teardown(tab) {
  clearInterval(tab.watchdog);
  if (tab.simple) {
    tab.simple.destroy();
    tab.simple = null;
  }
  if (tab.frame && engine.controller) engine.destroyFrame(tab.frame);
  tab.frame = null;
  tab.iframe?.remove();
  tab.iframe = null;
  tab.ntp?.remove();
  tab.ntp = null;
}

function renderTabs() {
  dom.tabs.innerHTML = state.tabs
    .map((t) => {
      const favicon = t.favicon
        ? `<img class="tab-favicon" src="${esc(t.favicon)}" alt="">`
        : `<span class="tab-favicon"></span>`;
      return `<button class="tab ${t.id === state.activeId ? "active" : ""}" data-id="${t.id}" role="tab"
        aria-selected="${t.id === state.activeId}" title="${esc(t.title)}">
        ${favicon}
        <span class="tab-title">${esc(t.title)}</span>
        <span class="tab-close" data-close="${t.id}" role="button" aria-label="Close tab">×</span>
      </button>`;
    })
    .join("");
}

dom.tabs.addEventListener("click", (e) => {
  const closeId = e.target.dataset?.close;
  if (closeId) {
    e.stopPropagation();
    closeTab(closeId);
    return;
  }
  const btn = e.target.closest?.(".tab");
  if (btn?.dataset.id) activate(btn.dataset.id);
});

dom.newTab.addEventListener("click", () => {
  const tab = makeTab();
  activate(tab.id);
  renderNewTab(tab);
  focusOmnibox();
});

/* ------------------------------------------------------------------ */
/* Per-tab chrome                                                      */
/* ------------------------------------------------------------------ */

function setTabTitle(tab, title) {
  const next = String(title || "").trim() || hostOf(tab.url) || "New tab";
  if (next === tab.title) return;
  tab.title = next;
  renderTabs();
}

function setTabUrl(tab, url) {
  if (!url || url === tab.url) return;
  const i = tab.stackIndex;
  if (i >= 0 && tab.stack[i + 1] === url) tab.stackIndex += 1;
  else if (tab.stack[i - 1] === url) tab.stackIndex -= 1;
  else {
    tab.stack = tab.stack.slice(0, i + 1);
    tab.stack.push(url);
    tab.stackIndex = tab.stack.length - 1;
  }
  tab.url = url;
  tab.favicon = faviconFor(url);
  tab.activity = Date.now();
  if (!tab.title || tab.title === "New tab") setTabTitle(tab, hostOf(url));
  renderTabs();
  if (tab.id === state.activeId) syncChrome();
}

function syncChrome() {
  const tab = activeTab();
  if (!tab) return;
  if (document.activeElement !== dom.omnibox) {
    dom.omnibox.value = tab.url || "";
  }
  dom.omniClear.hidden = !dom.omnibox.value;
  dom.omniIcon.style.opacity = tab.url ? "0" : "1";

  const hasPage = tab.mode === "scramjet" || tab.mode === "simple";
  dom.back.disabled = !(hasPage && tab.stackIndex > 0);
  dom.forward.disabled = !(
    hasPage &&
    (tab.mode === "simple"
      ? tab.simple?.canForward
      : tab.stackIndex >= 0 && tab.stackIndex < tab.stack.length - 1)
  );
  dom.reload.disabled = !hasPage;
  dom.home.disabled = false;
  const starred = !!tab.url && bookmarks.has(tab.url);
  dom.star.classList.toggle("on", starred);
}

/* ------------------------------------------------------------------ */
/* New tab page                                                        */
/* ------------------------------------------------------------------ */

function renderNewTab(tab) {
  teardownSurface(tab);
  tab.mode = "ntp";
  tab.url = "";
  tab.title = "New tab";
  tab.favicon = "";
  tab.stack = [];
  tab.stackIndex = -1;

  const wrap = document.createElement("div");
  wrap.className = "ntp";
  const marks = bookmarks
    .all()
    .slice(0, 12)
    .map(
      (b) => `<div class="link-wrap">
        <a class="link" href="#" data-url="${esc(b.url)}">
          <span class="tile" style="background:#3b4a63">${esc((hostOf(b.url) || "?").slice(0, 1).toUpperCase())}</span>
          <span>${esc(b.title || hostOf(b.url) || b.url)}</span>
        </a>
        <button class="x" data-remove="${esc(b.url)}" title="Remove bookmark">×</button>
      </div>`,
    )
    .join("");

  wrap.innerHTML = `
    <h1>Relay <span>Hub</span></h1>
    <p class="tagline">Search the web, or type a URL. Everything runs right here in your browser.</p>
    <form class="ntp-search" autocomplete="off">
      <input type="text" placeholder="Search or type a URL" aria-label="Search or type a URL" spellcheck="false" />
      <button class="go" type="submit">Go</button>
    </form>
    <h2>Quick links</h2>
    <div class="links">
      ${QUICK_LINKS.map(
        (l) => `<a class="link" href="#" data-url="${esc(l.url)}">
          <span class="tile" style="background:${esc(l.color)}">${esc(l.icon)}</span>
          <span>${esc(l.name)}</span>
        </a>`,
      ).join("")}
    </div>
    ${marks ? `<h2>Bookmarks</h2><div class="links">${marks}</div>` : ""}
    <p class="engine-note">
      Relay Hub loads its full proxy engine the first time you open a page — that is the
      one-time download you will see. After that, browsing is instant.
    </p>`;

  wrap.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = e.target.querySelector("input").value;
    if (value.trim()) navigate(tab, value);
  });
  wrap.addEventListener("click", (e) => {
    const remove = e.target.dataset?.remove;
    if (remove) {
      e.preventDefault();
      bookmarks.remove(remove);
      renderNewTab(tab);
      return;
    }
    const link = e.target.closest?.("[data-url]");
    if (link?.dataset.url) {
      e.preventDefault();
      navigate(tab, link.dataset.url);
    }
  });

  tab.view.appendChild(wrap);
  tab.ntp = wrap;
  renderTabs();
  syncChrome();
  const input = wrap.querySelector("input");
  setTimeout(() => input?.focus(), 30);
}

function teardownSurface(tab) {
  clearInterval(tab.watchdog);
  if (tab.simple) {
    tab.simple.destroy();
    tab.simple = null;
  }
  if (tab.frame && engine.controller) engine.destroyFrame(tab.frame);
  tab.frame = null;
  tab.iframe?.remove();
  tab.iframe = null;
  tab.ntp?.remove();
  tab.ntp = null;
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function resolveInput(raw) {
  return normaliseInput(raw, {
    search: settings.get("search"),
    engines: SEARCH_ENGINES,
    bangs: BANGS,
  });
}

async function ensureEngine() {
  if (engine.ready) return engine.controller;
  if (state.enginePromise) return state.enginePromise;
  progress(true);
  state.enginePromise = engine
    .init({ transport: settings.get("transport"), wisp: settings.get("wisp") })
    .finally(() => {
      state.enginePromise = null;
    });
  return state.enginePromise;
}

function makeIframe(tab, { sandboxed }) {
  teardownSurface(tab);
  const iframe = document.createElement("iframe");
  iframe.className = "frame";
  iframe.title = "Browsing surface";
  if (sandboxed) {
    // Simple mode: no access to Relay Hub, no cookies, no top navigation.
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-forms allow-popups allow-modals allow-downloads",
    );
  } else {
    iframe.setAttribute("allow", "autoplay; clipboard-read; clipboard-write; fullscreen; picture-in-picture; encrypted-media; display-capture; midi; geolocation; microphone; camera");
    iframe.setAttribute("referrerpolicy", "no-referrer");
  }
  tab.view.appendChild(iframe);
  tab.iframe = iframe;
  return iframe;
}

function startWatchdog(tab) {
  clearInterval(tab.watchdog);
  const started = Date.now();
  tab.activity = started;
  tab.watchdog = setInterval(() => {
    if (Date.now() - tab.activity < 16000) return;
    clearInterval(tab.watchdog);
    if (tab.id !== state.activeId) return;
    progress(false);
    banner("This page is taking a while. The Wisp endpoint may be blocked on this network.", {
      kind: "warn",
      action: { label: "Try Simple mode", run: () => navigate(tab, tab.url, { forceMode: "simple" }) },
    });
  }, 2000);
}

async function attachScramjet(tab, url) {
  const iframe = makeIframe(tab, { sandboxed: false });
  tab.mode = "scramjet";
  tab.frame = engine.createFrame(iframe, {
    onUrl: (u) => {
      setTabUrl(tab, u);
      tab.activity = Date.now();
    },
    onTitle: (t) => {
      if (t) setTabTitle(tab, t);
      tab.activity = Date.now();
    },
    onLoad: () => {
      tab.activity = Date.now();
      clearInterval(tab.watchdog);
      if (tab.id === state.activeId) progress(false);
      hideBanner();
    },
    onError: (err) => {
      tab.lastError = err;
      console.warn("[relay] frame error", err);
    },
    onEscaped: (u) => new URL(`${appUrl("index.html")}#open=${encodeURIComponent(u.href)}`, location.href).href,
  });
  tab.frame.go(url);
}

async function attachSimple(tab, url) {
  const iframe = makeIframe(tab, { sandboxed: true });
  tab.mode = "simple";
  tab.simple = new SimpleFrame(iframe, {
    onUrl: (u) => setTabUrl(tab, u),
    onTitle: (t) => {
      if (t) setTabTitle(tab, t);
    },
    onLoad: () => {
      clearInterval(tab.watchdog);
      if (tab.id === state.activeId) progress(false);
    },
    onNav: (u, opts) => {
      if (opts?.newTab) openTab(u);
      else navigate(tab, u, { forceMode: "simple" });
    },
    onOpen: (u) => openTab(u),
    onProxy: (name) => {
      if (tab.id === state.activeId) banner(`Using Simple mode via the ${name} mirror.`, { timeout: 3500 });
    },
    onError: (err) => showLoadError(tab, err),
  });
  startWatchdog(tab);
  await tab.simple.go(url);
  clearInterval(tab.watchdog);
  progress(false);
}

function showLoadError(tab, err) {
  progress(false);
  clearInterval(tab.watchdog);
  const message = err?.message || "That page could not be loaded.";
  if (tab.mode === "simple") {
    banner(message, { kind: "error" });
    return;
  }
  banner(message, {
    kind: "error",
    action: { label: "Try Simple mode", run: () => navigate(tab, tab.url, { forceMode: "simple" }) },
  });
}

async function navigate(tab, raw, { forceMode = null } = {}) {
  if (!tab) return;
  const input = String(raw ?? "").trim();
  if (!input) {
    renderNewTab(tab);
    return;
  }
  const url = safeUrl(input) ? safeUrl(input).href : resolveInput(input);
  if (!url) return;

  hideBanner();
  hideSuggest();
  if (document.activeElement === dom.omnibox) dom.omnibox.blur();

  const mode = forceMode || settings.get("mode");
  const wantSimple = mode === "simple";

  // First load of a URL in this tab: seed history and labels immediately so
  // the UI responds before any network work finishes.
  if (tab.stack[tab.stackIndex] !== url) {
    tab.stack = tab.stack.slice(0, tab.stackIndex + 1);
    tab.stack.push(url);
    tab.stackIndex = tab.stack.length - 1;
  }
  tab.url = url;
  tab.favicon = faviconFor(url);
  setTabTitle(tab, hostOf(url) || "Loading…");
  syncChrome();
  progress(true);

  if (!wantSimple) {
    try {
      await ensureEngine();
    } catch (err) {
      console.error("[relay] engine failed", err);
      if (mode === "auto") {
        banner(`${err.message} Switching to Simple mode.`, { kind: "warn", timeout: 6000 });
        return navigate(tab, url, { forceMode: "simple" });
      }
      progress(false);
      banner(`${err.message} Open Settings to pick a different endpoint or engine.`, {
        kind: "error",
        action: { label: "Settings", run: () => openDrawer() },
      });
      return;
    }
  }

  try {
    if (wantSimple) {
      await attachSimple(tab, url);
    } else {
      await attachScramjet(tab, url);
      startWatchdog(tab);
    }
  } catch (err) {
    showLoadError(tab, err);
  } finally {
    // The tab's engine is only known once the surface is attached, and that
    // is what decides whether back/forward/reload apply.
    syncChrome();
  }
}

function openTab(url) {
  const tab = makeTab();
  activate(tab.id);
  navigate(tab, url);
  return tab;
}

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */

dom.back.addEventListener("click", () => {
  const tab = activeTab();
  if (!tab) return;
  if (tab.mode === "simple" && tab.simple) tab.simple.back();
  else if (tab.frame) {
    tab.stackIndex = Math.max(0, tab.stackIndex - 1);
    tab.frame.back();
    syncChrome();
  }
});

dom.forward.addEventListener("click", () => {
  const tab = activeTab();
  if (!tab) return;
  if (tab.mode === "simple" && tab.simple) tab.simple.forward();
  else if (tab.frame) {
    tab.stackIndex = Math.min(tab.stack.length - 1, tab.stackIndex + 1);
    tab.frame.forward();
    syncChrome();
  }
});

dom.reload.addEventListener("click", () => {
  const tab = activeTab();
  if (!tab) return;
  progress(true);
  startWatchdog(tab);
  if (tab.mode === "simple" && tab.simple) tab.simple.reload().catch((e) => showLoadError(tab, e));
  else tab.frame?.reload();
});

dom.home.addEventListener("click", () => {
  const tab = activeTab();
  if (tab) renderNewTab(tab);
});

dom.star.addEventListener("click", () => {
  const tab = activeTab();
  if (!tab?.url) return;
  if (bookmarks.has(tab.url)) {
    bookmarks.remove(tab.url);
    banner("Bookmark removed.", { timeout: 2000 });
  } else {
    bookmarks.add({ url: tab.url, title: tab.title });
    banner("Bookmarked.", { timeout: 2000 });
  }
  syncChrome();
});

dom.blank.addEventListener("click", () => openBlankWindow());
dom.settingsBtn.addEventListener("click", () => openDrawer());
dom.drawerClose.addEventListener("click", () => closeDrawer());

function focusOmnibox() {
  dom.omnibox.focus();
  dom.omnibox.select();
}

/* ------------------------------------------------------------------ */
/* Address bar + suggestions                                           */
/* ------------------------------------------------------------------ */

let suggestTimer = null;
let suggestAbort = null;

dom.omnibox.addEventListener("input", () => {
  dom.omniClear.hidden = !dom.omnibox.value;
  queueSuggest(dom.omnibox.value);
});

dom.omnibox.addEventListener("focus", () => {
  dom.omnibox.select();
  queueSuggest(dom.omnibox.value);
});

dom.omnibox.addEventListener("keydown", (e) => {
  if (dom.suggest.hidden) {
    if (e.key === "Enter") commitOmnibox();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = state.suggestItems.length;
    if (!n) return;
    state.suggestIndex = (state.suggestIndex + (e.key === "ArrowDown" ? 1 : -1) + n + 1) % (n + 1);
    paintSuggest();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const picked = state.suggestItems[state.suggestIndex];
    commitOmnibox(picked ? picked.value : undefined);
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    hideSuggest();
  }
});

dom.omniClear.addEventListener("click", () => {
  dom.omnibox.value = "";
  dom.omniClear.hidden = true;
  hideSuggest();
  focusOmnibox();
});

function commitOmnibox(value) {
  const raw = value ?? dom.omnibox.value;
  hideSuggest();
  if (!raw.trim()) return;
  navigate(activeTab() || makeTab(), raw);
}

dom.suggest.addEventListener("mousedown", (e) => {
  const item = e.target.closest?.(".suggest-item");
  if (!item) return;
  e.preventDefault();
  commitOmnibox(item.dataset.value);
});

function queueSuggest(raw) {
  clearTimeout(suggestTimer);
  const q = String(raw || "").trim();
  if (!q) return hideSuggest();
  if (!settings.get("suggestions")) {
    renderSuggest([{ label: q, value: q, kind: "go" }]);
    return;
  }
  suggestTimer = setTimeout(() => loadSuggest(q), 140);
}

async function loadSuggest(q) {
  try {
    suggestAbort?.abort();
    suggestAbort = new AbortController();
    const res = await fetch(`https://ac.duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`, {
      signal: suggestAbort.signal,
      credentials: "omit",
    });
    const data = await res.json();
    const phrases = Array.isArray(data?.[1]) ? data[1].slice(0, 7) : [];
    const items = [{ label: q, value: q, kind: resolveInput(q) }];

    for (const p of phrases) items.push({ label: p, value: p, kind: "suggestion" });
    renderSuggest(items);
  } catch {
    renderSuggest([{ label: q, value: q, kind: resolveInput(q) }]);
  }
}

function renderSuggest(items) {
  state.suggestItems = items;
  state.suggestIndex = 0;
  if (!items.length) return hideSuggest();
  paintSuggest();
}

function paintSuggest() {
  dom.suggest.hidden = false;
  dom.suggest.innerHTML = state.suggestItems
    .map((item, i) => {
      const kind = item.kind === "suggestion" ? "search" : prettyUrl(item.kind) || "go";
      return `<button class="suggest-item ${i === state.suggestIndex ? "sel" : ""}"
        data-value="${esc(item.value)}" role="option">
        <span>${esc(item.label)}</span><span class="kind">${esc(kind)}</span>
      </button>`;
    })
    .join("");
}

function hideSuggest() {
  dom.suggest.hidden = true;
  dom.suggest.innerHTML = "";
  state.suggestItems = [];
  state.suggestIndex = -1;
}

document.addEventListener("click", (e) => {
  if (!dom.suggest.hidden && !e.target.closest("#omnibox-wrap") && !e.target.closest("#suggest")) {
    hideSuggest();
  }
});

/* ------------------------------------------------------------------ */
/* Settings drawer                                                     */
/* ------------------------------------------------------------------ */

function openDrawer() {
  syncSettingsForm();
  dom.drawer.hidden = false;
  refreshStatus();
}
function closeDrawer() {
  dom.drawer.hidden = true;
}

function syncSettingsForm() {
  $("set-mode").value = settings.get("mode");
  $("set-transport").value = settings.get("transport");
  $("set-wisp").value = settings.get("wisp");
  $("set-search").value = settings.get("search");
  $("set-theme").value = settings.get("theme");
  $("set-cloak").value = settings.get("cloak");
  $("set-panic").value = settings.get("panicKey");
  $("set-suggestions").checked = !!settings.get("suggestions");
  $("set-blank").checked = !!settings.get("openInBlank");
}

function buildSelects() {
  $("set-search").innerHTML = Object.entries(SEARCH_ENGINES)
    .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`)
    .join("");
  $("set-theme").innerHTML = THEMES.map(
    (t) => `<option value="${t}">${esc(t[0].toUpperCase() + t.slice(1))}</option>`,
  ).join("");
  $("set-cloak").innerHTML = CLOAK_PRESETS.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join("");
}

$("set-mode").addEventListener("change", (e) => {
  settings.set("mode", e.target.value);
  banner("New tabs and reloads will use this engine.", { timeout: 2500 });
});
$("set-transport").addEventListener("change", (e) => {
  settings.set("transport", e.target.value);
});
$("set-search").addEventListener("change", (e) => settings.set("search", e.target.value));
$("set-theme").addEventListener("change", (e) => {
  settings.set("theme", e.target.value);
  applyTheme();
});
$("set-cloak").addEventListener("change", (e) => {
  settings.set("cloak", e.target.value);
  applyCloak();
});
$("set-panic").addEventListener("change", (e) => settings.set("panicKey", e.target.value.slice(-1) || "`"));
$("set-suggestions").addEventListener("change", (e) => settings.set("suggestions", e.target.checked));
$("set-blank").addEventListener("change", (e) => settings.set("openInBlank", e.target.checked));

$("set-wisp-test").addEventListener("click", async () => {
  const value = $("set-wisp").value.trim();
  const status = $("wisp-status");
  status.innerHTML = `<span class="dot"></span>Testing…`;
  if (!value) {
    refreshStatus();
    banner("Enter a wss:// endpoint to test, or leave it blank to use the automatic pool.", {
      timeout: 3500,
    });
    return;
  }
  const { probeWisp } = await import("./engine.js");
  const ms = await probeWisp(value, 8000);
  status.innerHTML =
    ms === null
      ? `<span class="dot bad"></span><b>${esc(value)}</b> did not answer.`
      : `<span class="dot on"></span><b>${esc(value)}</b> answered in ${ms} ms.`;
});

$("set-reconnect").addEventListener("click", async () => {
  const wisp = $("set-wisp").value.trim();
  settings.set("wisp", wisp);
  $("set-reconnect").disabled = true;
  $("set-reconnect").textContent = "Reconnecting…";
  try {
    await engine.reconnect({ transport: settings.get("transport"), wisp });
    refreshStatus();
    banner("Reconnected.", { timeout: 2500 });
  } catch (err) {
    refreshStatus();
    banner(err.message, { kind: "error" });
  } finally {
    $("set-reconnect").disabled = false;
    $("set-reconnect").textContent = "Reconnect with these settings";
  }
});

$("set-clear").addEventListener("click", async () => {
  await engine.reset();
  banner("Cookies, cache and site data cleared. Reload the page to start fresh.", {
    action: { label: "Reload", run: () => location.reload() },
  });
});

$("set-reset").addEventListener("click", () => {
  settings.reset();
  applyTheme();
  applyCloak();
  syncSettingsForm();
  banner("Settings reset to defaults.", { timeout: 2500 });
});

$("set-blank-now").addEventListener("click", () => openBlankWindow());

$("set-panic-test").addEventListener("click", () => {
  togglePanic(true);
  banner("Panic screen shown — press your panic key again to come back.", { timeout: 4000 });
  setTimeout(() => togglePanic(false), 2500);
});

function refreshStatus() {
  const el = $("wisp-status");
  if (engine.ready) {
    el.innerHTML = `<span class="dot on"></span>Connected to <b>${esc(engine.wispUrl)}</b>
      ${engine.wispLatency != null ? `in ${engine.wispLatency} ms` : ""} ·
      transport <b>${esc(engine.transport)}</b>`;
  } else if (engine.status === "error") {
    el.innerHTML = `<span class="dot bad"></span>${esc(engine.error?.message || "Disconnected.")}`;
  } else {
    el.innerHTML = `<span class="dot"></span>Not connected yet — the engine starts on your first page load.`;
  }
}
engine.onStatus(() => refreshStatus());

/* ------------------------------------------------------------------ */
/* Cloaking, panic, about:blank                                        */
/* ------------------------------------------------------------------ */

function togglePanic(force) {
  state.panicked = force === undefined ? !state.panicked : force;
  if (state.panicked) {
    const preset = cloakPreset();
    document.title = preset.title;
    let link = document.querySelector('link[rel="icon"]');
    if (link) link.href = preset.icon;
    dom.panic.hidden = false;
  } else {
    dom.panic.hidden = true;
    applyCloak();
  }
}

function openBlankWindow() {
  const preset = cloakPreset();
  const w = window.open("", "_blank");
  if (!w) {
    banner("Your browser blocked the popup. Allow popups for this site to use this feature.", {
      kind: "warn",
    });
    return;
  }
  const src = new URL(appUrl("index.html"), location.href).href;
  w.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(preset.title)}</title>
<link rel="icon" href="${esc(preset.icon)}">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}
iframe{border:0;width:100vw;height:100vh;display:block}</style></head>
<body><iframe src="${esc(src)}" allow="autoplay; fullscreen; clipboard-read; clipboard-write; encrypted-media; picture-in-picture"></iframe></body></html>`);
  w.document.close();
  banner("Opened in an about:blank window. You can close this tab.", { timeout: 6000 });
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");

  // Panic key works everywhere except while typing.
  const panicKey = settings.get("panicKey") || "`";
  if (!typing && e.key === panicKey) {
    e.preventDefault();
    togglePanic();
    return;
  }
  if (e.key === "Escape") {
    if (!dom.drawer.hidden) closeDrawer();
    else if (!dom.suggest.hidden) hideSuggest();
    return;
  }
  if (!e.altKey || e.ctrlKey || e.metaKey) return;

  const key = e.key.toLowerCase();
  if (key === "t") {
    e.preventDefault();
    dom.newTab.click();
  } else if (key === "w") {
    e.preventDefault();
    closeTab(state.activeId);
  } else if (key === "l") {
    e.preventDefault();
    focusOmnibox();
  } else if (key === "r") {
    e.preventDefault();
    dom.reload.click();
  } else if (key === "arrowleft") {
    e.preventDefault();
    dom.back.click();
  } else if (key === "arrowright") {
    e.preventDefault();
    dom.forward.click();
  } else if (/^[1-9]$/.test(key)) {
    e.preventDefault();
    const tab = state.tabs[Number(key) - 1] || state.tabs[state.tabs.length - 1];
    if (tab) activate(tab.id);
  }
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function handleHash() {
  const m = location.hash.match(/^#open=(.*)$/);
  if (!m) return null;
  let url = "";
  try {
    url = decodeURIComponent(m[1]);
  } catch {
    url = m[1];
  }
  history.replaceState(null, "", location.pathname + location.search);
  return safeUrl(url)?.href || "";
}

function boot() {
  applyTheme();
  applyCloak();
  buildSelects();
  syncSettingsForm();

  const build = window.RELAY_BUILD;
  $("about-version").textContent = build?.built
    ? `Build ${build.built.slice(0, 10)}${build.commit ? ` · ${build.commit.slice(0, 7)}` : ""} · deployed by GitHub Actions.`
    : "Running straight from source — no build step has run.";

  const first = makeTab();
  activate(first.id);
  renderNewTab(first);

  const escaped = handleHash();
  if (escaped) {
    navigate(first, escaped);
  }

  dom.boot.classList.add("fade");
  setTimeout(() => {
    dom.boot.hidden = true;
    dom.chrome.hidden = false;
  }, 320);

  if (settings.get("openInBlank") && window.self === window.top) {
    // Only auto-launch from a top-level tab, never from inside the blank window.
    settings.set("openInBlank", false);
    openBlankWindow();
  }

  engine.onStatus((status) => {
    if (status === "loading") dom.bootStatus.textContent = "Starting the proxy engine…";
    if (status === "error") refreshStatus();
  });
}

boot();
