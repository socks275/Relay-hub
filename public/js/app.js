/* Pine — the hub. Wires the proxy engine, browser tabs, catalogue tabs,
 * chat, AI, music, profile/coins/shop, cloaking and panic together. */
import {
  state, save, subscribe, earn, spend, owns, level, claimDaily,
  addHistory, updateHistoryTitle, isBookmarked, toggleBookmark,
  hostOf, continueSites, resetAll,
} from "./store.js";
import {
  APPS, GAMES, WATCH_SERVICES, LISTEN_SERVICES, STATIONS, CLOAKS,
  DEFAULT_TITLE, THEMES, NAME_COLORS, SHOP, PRO_PRICE, STUDY_TOPICS,
  SEARCH_ENGINES,
} from "./data.js";
import { proxy, normaliseInput, readerUrl, urlFromReaderLocation, faviconFor, defaultWispUrl } from "./proxy.js";
import { music } from "./music.js";
import { askAI, resetAI } from "./ai.js";
import { ChatClient } from "./chat.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const isEditing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;

const BADGE_ICONS = { leaf: "🍃", star: "⭐", diamond: "💎", crown: "👑" };
const ENGINE_LABELS = { scramjet: "Scramjet", reader: "Reader", direct: "Direct" };

/* ------------------------------------------------------------------ */
/* Toasts                                                             */
/* ------------------------------------------------------------------ */
let coinToast = null, coinSum = 0, coinTimer = null;
export function toast(msg, kind = "", ms = 3400) {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 320); }, ms);
  while (box.children.length > 4) box.firstChild.remove();
  return el;
}
window.addEventListener("pine:coins", (e) => {
  const { amount, reason } = e.detail;
  if (amount <= 0) return;
  coinSum += amount;
  if (!coinToast || !coinToast.isConnected) coinToast = toast("", "coin", 2200);
  coinToast.textContent = `+${coinSum} 🪙${reason ? ` · ${reason}` : ""}`;
  clearTimeout(coinTimer);
  coinTimer = setTimeout(() => { coinToast = null; coinSum = 0; }, 2300);
});

/* ------------------------------------------------------------------ */
/* Theme, cloak, panic                                                */
/* ------------------------------------------------------------------ */
function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme in THEMES ? state.settings.theme : "pine";
  document.documentElement.dataset.motion = state.settings.reduceMotion ? "reduce" : "";
}
function cloakInfo() {
  const s = state.settings;
  const preset = CLOAKS[s.cloakPreset] || CLOAKS.none;
  return {
    title: s.cloakTitle || preset.title || DEFAULT_TITLE,
    icon: s.cloakIcon || preset.icon || "/favicon.svg",
  };
}
function applyCloak() {
  const { title, icon } = cloakInfo();
  document.title = title;
  const link = $("#favicon");
  if (link.getAttribute("href") !== icon) link.setAttribute("href", icon);
}
const realTitle = () => DEFAULT_TITLE;
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.settings.cloakOnHide) applyCloak();
  else if (!document.hidden && state.settings.cloakPreset === "none" && !state.settings.cloakTitle) document.title = realTitle();
  else if (!document.hidden) applyCloak();
});
function panic() {
  const dest = state.settings.panicUrl || "https://classroom.google.com";
  location.replace(/^https?:\/\//i.test(dest) ? dest : "https://" + dest);
}
$("#panic-btn").addEventListener("click", panic);

function openBlank(frameSrc, title) {
  const w = window.open("about:blank", "_blank");
  if (!w) { toast("Popup blocked — allow popups for Pine, then try again.", "err"); return; }
  const { icon } = cloakInfo();
  w.document.open();
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title || cloakInfo().title)}</title>` +
    `<link rel="icon" href="${esc(icon)}"><style>html,body{margin:0;height:100%;background:#08110b}iframe{border:0;width:100%;height:100%;display:block}</style></head>` +
    `<body><iframe src="${esc(frameSrc)}" allow="autoplay; fullscreen; clipboard-read; clipboard-write; encrypted-media; picture-in-picture"></iframe></body></html>`
  );
  w.document.close();
  toast("Opened cloaked 🥷 This tab stays as your cover.");
}

/* ------------------------------------------------------------------ */
/* Views / navigation                                                 */
/* ------------------------------------------------------------------ */
let currentView = "home";
const lazyDone = new Set();
function showView(name) {
  currentView = name;
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
  $$(".rail-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("#main").scrollTo?.(0, 0);
  window.scrollTo(0, 0);
  if (name === "home") { renderHomeDynamic(); refreshNetStats(); }
  if (name === "chat" && !lazyDone.has("chat")) { lazyDone.add("chat"); initChat(); }
  if (name === "chat") chat?.connect(chat.room);
  if (name === "settings") refreshSettings();
  if (name === "browse" && !tabs.length) renderBrowseEmpty();
}
$$(".rail-btn[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-goto-view]");
  if (t) showView(t.dataset.gotoView);
});

/* ------------------------------------------------------------------ */
/* Omnibox with suggestions                                           */
/* ------------------------------------------------------------------ */
function attachOmnibox(form, input, box, onGo) {
  let items = [], sel = -1, abort = null, debounce = null, generation = 0;
  // Bumping the generation invalidates any in-flight suggestion fetch, so a
  // slow response can't reopen the dropdown after submit/pick/blur.
  const close = () => { generation++; abort?.abort(); box.hidden = true; sel = -1; };
  const render = () => {
    if (!items.length) return close();
    box.innerHTML = items.map((it, i) =>
      `<button type="button" class="sugg-item${i === sel ? " sel" : ""}" data-i="${i}">` +
      (it.icon ? `<img src="${esc(it.icon)}" alt="" loading="lazy" onerror="this.remove()">` : "") +
      `<span>${esc(it.label)}</span><small>${esc(it.kind)}</small></button>`).join("");
    box.hidden = false;
    $$(".sugg-item", box).forEach((b) => b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pick(items[Number(b.dataset.i)]);
    }));
  };
  const pick = (it) => {
    if (!it) return;
    close();
    input.value = it.url ? it.url : it.label;
    onGo(it.url || normaliseInput(it.label, state.settings.search));
  };
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (!q) { items = []; return close(); }
    const myGen = ++generation;
    debounce = setTimeout(async () => {
      if (myGen !== generation) return;
      const local = [];
      const seen = new Set();
      for (const e of [...state.bookmarks, ...state.history]) {
        if (local.length >= 4) break;
        const hay = (e.title + " " + e.url).toLowerCase();
        if (hay.includes(q.toLowerCase()) && !seen.has(e.url)) {
          seen.add(e.url);
          local.push({ label: e.title, url: e.url, kind: state.bookmarks.includes(e) ? "bookmark" : "history", icon: faviconFor(e.url) });
        }
      }
      items = [...local];
      const direct = normaliseInput(q, state.settings.search);
      if (/^https?:\/\//.test(q) || (!/\s/.test(q) && q.includes(".")))
        items.push({ label: q, url: direct, kind: "visit", icon: faviconFor(direct) });
      render();
      try {
        abort?.abort();
        abort = new AbortController();
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`, { signal: abort.signal });
        const data = await res.json();
        if (myGen !== generation || input.value.trim() !== q) return;
        const remote = (data.suggestions || []).filter((s) => s.toLowerCase() !== q.toLowerCase())
          .map((s) => ({ label: s, kind: "search" }));
        items = [...local, ...(items.find((i) => i.kind === "visit") ? [items.find((i) => i.kind === "visit")] : []), ...remote].slice(0, 9);
        render();
      } catch { /* suggestions are best-effort */ }
    }, 170);
  });
  input.addEventListener("keydown", (e) => {
    if (box.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(-1, sel - 1); render(); }
    else if (e.key === "Escape") close();
    else if (e.key === "Enter" && sel >= 0) { e.preventDefault(); pick(items[sel]); }
  });
  input.addEventListener("blur", () => setTimeout(close, 140));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    close();
    const url = normaliseInput(input.value, state.settings.search);
    if (url) onGo(url);
  });
  return { close };
}

/* ------------------------------------------------------------------ */
/* Browser tabs                                                       */
/* ------------------------------------------------------------------ */
const tabs = [];
let activeTabId = null;
let tabSeq = 0;
const $frames = $("#frames");
const activeTab = () => tabs.find((t) => t.id === activeTabId) || null;

function renderTabs() {
  const strip = $("#tabstrip");
  strip.innerHTML = tabs.map((t) =>
    `<div class="tab${t.id === activeTabId ? " active" : ""}${t.loading ? " spin" : ""}" role="tab" data-id="${t.id}" title="${esc(t.url || t.title)}">` +
    (t.url ? `<img src="${esc(faviconFor(t.url))}" alt="" loading="lazy" onerror="this.remove()">` : "") +
    `<span class="tab-title">${esc(t.title || "New tab")}</span>` +
    `<button class="tab-x" data-close="${t.id}" title="Close tab" aria-label="Close tab"><svg><use href="#i-x"/></svg></button></div>`).join("");
  $$(".tab", strip).forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return;
      activateTab(Number(el.dataset.id));
    });
  });
  $$("[data-close]", strip).forEach((b) => b.addEventListener("click", () => closeTab(Number(b.dataset.close))));
  const badge = $("#browse-badge");
  badge.hidden = !tabs.length;
  badge.textContent = String(tabs.length);
  $("#browse-empty").style.display = tabs.length ? "none" : "flex";
}

function syncBrowserChrome() {
  const t = activeTab();
  const addr = $("#addr-input");
  if (document.activeElement !== addr) addr.value = t?.url || "";
  $("#engine-sel").value = t?.engine || state.settings.engine;
  $("#loadbar").classList.toggle("on", !!t?.loading);
  $("#nav-star").classList.toggle("on", !!(t?.url && isBookmarked(t.url)));
  $("#star-use").setAttribute("href", t?.url && isBookmarked(t.url) ? "#i-star-fill" : "#i-star");
  $("#status-engine").textContent = ENGINE_LABELS[t?.engine || state.settings.engine];
  $("#status-transport").textContent = state.settings.transport;
  $("#status-state").textContent = t ? (t.loading ? "loading…" : "done") : "idle";
  $("#status-url").textContent = t?.url ? hostOf(t.url) : "";
  renderTabs();
}

function setTabLoading(tab, on) {
  tab.loading = on;
  if (tab.id === activeTabId) syncBrowserChrome(); else renderTabs();
}

function showTabError(tab, message) {
  tab.lastError = message;
  setTabLoading(tab, false);
  if (tab.id !== activeTabId) return;
  $("#tab-error-msg").textContent = message;
  $("#tab-error-url").textContent = tab.url || "";
  $("#tab-error").hidden = false;
  tab.iframe.style.visibility = "hidden";
}
function hideTabError() {
  $("#tab-error").hidden = true;
  const t = activeTab();
  if (t) t.iframe.style.visibility = "";
}

function stopReaderPoll(tab) {
  if (tab.readerPoll) { clearInterval(tab.readerPoll); tab.readerPoll = null; }
}
function startReaderPoll(tab) {
  stopReaderPoll(tab);
  tab.readerPoll = setInterval(() => {
    try {
      const href = tab.iframe.contentWindow?.location.href || "";
      const real = urlFromReaderLocation(href);
      if (real && real !== tab.url) {
        tab.url = real;
        addHistory(real, tab.title);
        if (tab.id === activeTabId) syncBrowserChrome(); else renderTabs();
      }
      const title = tab.iframe.contentDocument?.title;
      if (title && title !== tab.title) {
        tab.title = title.replace(/ · Pine Reader$/, "").slice(0, 80);
        updateHistoryTitle(tab.url, tab.title);
        renderTabs();
      }
    } catch { /* cross-origin (direct engine) — nothing to sync */ }
  }, 650);
}

async function navigateTab(tab, raw, { engine = tab.engine, fallbackOnce = true } = {}) {
  const url = /^https?:\/\//i.test(raw || "") ? raw : normaliseInput(raw, state.settings.search);
  if (!url) return;
  tab.engine = engine;
  tab.url = url;
  tab.lastError = null;
  if (tab.title === "New tab" || !tab.title) tab.title = hostOf(url);
  addHistory(url, tab.title);
  earn(1, "browse");
  hideTabError();
  setTabLoading(tab, true);
  clearTimeout(tab.watchdog);
  syncBrowserChrome();
  stopReaderPoll(tab);

  if (engine === "reader") {
    tab.iframe.src = readerUrl(url);
    startReaderPoll(tab);
    return;
  }
  if (engine === "direct") {
    tab.iframe.src = url;
    startReaderPoll(tab); // harmless; lets same-origin direct pages sync too
    return;
  }
  // Scramjet:
  try {
    await proxy.init({ transport: state.settings.transport, customWisp: state.settings.customWisp });
  } catch (err) {
    if (fallbackOnce) {
      toast("Scramjet couldn't start — opened in Reader instead.", "err", 4500);
      return navigateTab(tab, url, { engine: "reader", fallbackOnce: false });
    }
    return showTabError(tab, `The proxy engine failed to start: ${err.message}`);
  }
  try {
    if (!tab.frame) {
      tab.frame = proxy.createFrame(tab.iframe, {
        onUrl(u) {
          if (u) tab.lastError = null; // page is alive — forget old errors
          if (!u || u === tab.url) return;
          tab.url = u;
          addHistory(u, tab.title);
          if (tab.id === activeTabId) syncBrowserChrome(); else renderTabs();
        },
        onTitle(title, u) {
          // Also keeps the address bar in sync if UrlWatcher is unavailable.
          if (u && u !== tab.url) {
            tab.url = u;
            addHistory(u, title || tab.title);
            if (tab.id === activeTabId) syncBrowserChrome();
          }
          if (!title) return;
          tab.title = title.slice(0, 80);
          updateHistoryTitle(u || tab.url, tab.title);
          renderTabs();
        },
        onLoad() { tab.lastError = null; hideTabError(); setTabLoading(tab, false); },
        onError(err, rawReq) {
          const dest = rawReq?.destination;
          if (dest === "iframe" || dest === "document" || dest === "") {
            const msg = String(err?.message || err || "Request failed.");
            showTabError(tab, /wisp|websocket|transport/i.test(msg)
              ? "The tunnel to that site dropped. Retry, or switch transport in Settings → Proxy."
              : `Couldn't load that page through Scramjet. (${msg.slice(0, 140)})`);
          }
        },
      });
    }
    tab.frame.go(url);
    tab.watchdog = setTimeout(() => {
      if (tab.loading && tab.id === activeTabId)
        showTabError(tab, "That site is taking a very long time. It may be blocking proxies, or the tunnel is struggling.");
    }, 22000);
  } catch (err) {
    showTabError(tab, `Scramjet hit a snag: ${err.message}`);
  }
}

function createTab({ url = "", engine = state.settings.engine, activate = true } = {}) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("allow", "autoplay; fullscreen; clipboard-read; clipboard-write; encrypted-media; picture-in-picture; web-share; microphone; camera; display-capture; gamepad; xr-spatial-tracking");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  const tab = { id: ++tabSeq, iframe, frame: null, url: "", title: "New tab", engine, loading: false, readerPoll: null, watchdog: null, lastError: null };
  iframe.addEventListener("load", () => {
    // The very first about:blank load of a fresh iframe isn't a real page.
    try { if (tab.url && iframe.contentWindow?.location.href === "about:blank") return; } catch { /* direct engine */ }
    if (tab.url) { tab.lastError = null; if (tab.id === activeTabId) hideTabError(); }
    setTabLoading(tab, false);
  });
  $frames.insertBefore(iframe, $("#browse-empty"));
  tabs.push(tab);
  if (activate || !activeTabId) activateTab(tab.id);
  else { iframe.classList.add("hidden-frame"); renderTabs(); }
  if (url) navigateTab(tab, url, { engine });
  return tab;
}

function activateTab(id) {
  activeTabId = id;
  for (const t of tabs) t.iframe.classList.toggle("hidden-frame", t.id !== id);
  const t = activeTab();
  if (t?.lastError && !t.loading) {
    $("#tab-error-msg").textContent = t.lastError;
    $("#tab-error-url").textContent = t.url || "";
    $("#tab-error").hidden = false;
    t.iframe.style.visibility = "hidden";
  } else {
    $("#tab-error").hidden = true;
    if (t) t.iframe.style.visibility = "";
  }
  syncBrowserChrome();
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  stopReaderPoll(t);
  clearTimeout(t.watchdog);
  t.iframe.remove();
  if (activeTabId === id) {
    const next = tabs[i] || tabs[i - 1];
    activeTabId = next ? next.id : null;
    if (next) activateTab(next.id);
  }
  syncBrowserChrome();
}

function openInBrowser(raw, { engine = state.settings.engine, newTab = true } = {}) {
  const url = /^https?:\/\//i.test(raw || "") ? raw : normaliseInput(raw, state.settings.search);
  if (!url) return;
  showView("browse");
  let tab = activeTab();
  if (newTab || !tab || (tab.url && tab.url !== url)) {
    if (tab && !tab.url) { /* reuse the blank tab */ }
    else tab = createTab({ engine });
  }
  if (tab.url !== url || tab.engine !== engine) navigateTab(tab, url, { engine });
}

function renderBrowseEmpty() {
  renderTabs();
  const quick = ["https://duckduckgo.com", "https://en.wikipedia.org", "https://www.youtube.com", "https://poki.com"];
  $("#empty-quick").innerHTML = quick.map((u) =>
    `<button class="chip" data-u="${esc(u)}">${esc(hostOf(u))}</button>`).join("");
  $$("#empty-quick .chip").forEach((b) => b.addEventListener("click", () => openInBrowser(b.dataset.u, { newTab: false })));
}

/* browser toolbar wiring */
attachOmnibox($("#addr-form"), $("#addr-input"), $("#addr-suggest"), (url) => {
  const t = activeTab() || createTab({});
  navigateTab(t, url, { engine: t.engine });
  $("#addr-input").blur();
});
$("#tab-add").addEventListener("click", () => { createTab({}); $("#addr-input").focus(); });
function tabHistory(dir) {
  const t = activeTab();
  if (!t) return;
  // history.back/forward are allowed cross-origin, so this also covers the
  // Direct engine. Never fall back to navigating the hub's own history.
  try {
    if (t.engine === "scramjet" && t.frame) dir < 0 ? t.frame.back() : t.frame.forward();
    else dir < 0 ? t.iframe.contentWindow.history.back() : t.iframe.contentWindow.history.forward();
  } catch { /* frame already gone */ }
}
$("#nav-back").addEventListener("click", () => tabHistory(-1));
$("#nav-fwd").addEventListener("click", () => tabHistory(1));
$("#nav-reload").addEventListener("click", () => {
  const t = activeTab();
  if (!t) return;
  hideTabError();
  t.lastError = null;
  setTabLoading(t, true);
  try {
    if (t.engine === "scramjet" && t.frame) t.frame.reload();
    else if (t.engine === "reader") navigateTab(t, t.url, { engine: "reader" });
    else t.iframe.contentWindow.location.reload();
  } catch { if (t.url) t.iframe.src = t.url; }
});
$("#nav-home").addEventListener("click", () => showView("home"));
$("#nav-star").addEventListener("click", () => {
  const t = activeTab();
  if (!t?.url) return;
  const on = toggleBookmark(t.url, t.title);
  toast(on ? "Bookmarked ⭐" : "Bookmark removed");
  syncBrowserChrome();
});
$("#engine-sel").addEventListener("change", (e) => {
  const t = activeTab();
  if (!t) { state.settings.engine = e.target.value; save(); return; }
  if (t.url) navigateTab(t, t.url, { engine: e.target.value });
  else { t.engine = e.target.value; syncBrowserChrome(); }
});
const menu = $("#browser-menu");
$("#browser-menu-btn").addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) menu.hidden = true; });
menu.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  menu.hidden = true;
  const t = activeTab();
  const act = btn.dataset.act;
  if (act === "blank" && t) {
    let src = "";
    try { src = t.iframe.contentWindow.location.href; } catch { /* cross-origin */ }
    if (!src || src === "about:blank") src = t.engine === "reader" ? new URL(readerUrl(t.url), location.href).href : (t.url || location.href);
    openBlank(src, t.title || "Pine");
  } else if (act === "fullscreen") {
    $(".browser").requestFullscreen?.().catch(() => toast("Fullscreen was blocked by the browser.", "err"));
  } else if (act === "copy" && t?.url) {
    const link = `${location.origin}/?goto=${encodeURIComponent(t.url)}`;
    try { await navigator.clipboard.writeText(link); toast("Pine link copied 🔗"); }
    catch { toast(link, "", 6000); }
  } else if (act === "original" && t?.url) {
    window.open(t.url, "_blank", "noopener,noreferrer");
  } else if (act.startsWith("engine-") && t?.url) {
    navigateTab(t, t.url, { engine: act.slice(7) });
  } else if (act === "history") {
    openHistoryModal();
  }
});
$("#tab-error").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-retry]");
  if (!btn) return;
  const t = activeTab();
  if (!t?.url) return;
  t.lastError = null;
  hideTabError();
  const mode = btn.dataset.retry;
  if (mode === "transport") {
    const next = state.settings.transport === "libcurl" ? "epoxy" : "libcurl";
    state.settings.transport = next;
    save();
    toast(`Transport switched to ${next} — retrying…`);
    try { await proxy.setTransport(next, state.settings.customWisp); } catch { /* navigate will surface errors */ }
    navigateTab(t, t.url, { engine: "scramjet" });
  } else {
    navigateTab(t, t.url, { engine: mode });
  }
});

/* ------------------------------------------------------------------ */
/* Tiles & catalogue rendering                                        */
/* ------------------------------------------------------------------ */
function tile({ name, desc, icon, imgIcon, badge, badgeClass = "" }, onClick) {
  const b = document.createElement("button");
  b.className = "tile";
  b.innerHTML =
    (badge ? `<span class="tile-badge ${badgeClass}">${esc(badge)}</span>` : "") +
    `<span class="tile-ic">${imgIcon ? `<img src="${esc(imgIcon)}" alt="" loading="lazy" onerror="this.parentElement.textContent='${esc(name[0] || "🌲")}'">` : esc(icon || "🌲")}</span>` +
    `<span class="tile-name">${esc(name)}</span>` +
    (desc ? `<span class="tile-desc">${esc(desc)}</span>` : "");
  b.addEventListener("click", onClick);
  return b;
}
const appTile = (app) => tile({ name: app.name, desc: app.desc, imgIcon: faviconFor(app.url) }, () => openInBrowser(app.url));

function renderHomeStatic() {
  $("#quick-grid").replaceChildren(...APPS.slice(0, 8).map(appTile));
  $("#study-grid").replaceChildren(...STUDY_TOPICS.map((t) =>
    tile({ name: t.subject, desc: t.blurb, icon: t.emoji }, () => openInBrowser(normaliseInput(t.q, state.settings.search)))));
}
function renderHomeDynamic() {
  const h = new Date().getHours();
  const greet = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  $("#greeting").textContent = state.profile.name && state.profile.name !== "guest" ? `${greet}, ${state.profile.name}.` : `${greet}.`;
  $("#hero-date").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  $("#hint-engine-name").textContent = ENGINE_LABELS[state.settings.engine];
  $("#panic-key-hint").textContent = state.settings.panicKey === "Escape" ? "Esc" : state.settings.panicKey;

  const cont = continueSites(10);
  $("#continue-wrap").hidden = !cont.length;
  $("#continue-row").innerHTML = cont.map((e) =>
    `<button class="site-chip" data-u="${esc(e.url)}"><img src="${esc(faviconFor(e.url))}" alt="" loading="lazy" onerror="this.remove()"><span>${esc(e.title)}</span><small>${esc(hostOf(e.url))}</small></button>`).join("");
  $$("#continue-row .site-chip").forEach((b) => b.addEventListener("click", () => openInBrowser(b.dataset.u)));

  $("#bookmarks-wrap").hidden = !state.bookmarks.length;
  $("#bookmarks-row").innerHTML = state.bookmarks.slice(0, 14).map((e) =>
    `<button class="site-chip" data-u="${esc(e.url)}"><img src="${esc(faviconFor(e.url))}" alt="" loading="lazy" onerror="this.remove()">⭐<span>${esc(e.title)}</span></button>`).join("");
  $$("#bookmarks-row .site-chip").forEach((b) => b.addEventListener("click", () => openInBrowser(b.dataset.u)));

  const today = new Date();
  const claimed = state.wallet.lastDaily === `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
  $("#daily-btn").disabled = claimed;
  $("#daily-btn").textContent = claimed ? "Claimed ✓" : "Claim";
  $("#stat-daily-amt").textContent = `+${state.profile.pro ? 2000 : 250} 🪙`;
}
$("#daily-btn").addEventListener("click", () => {
  const got = claimDaily();
  if (got) { toast(`Daily reward claimed: +${got} 🪙`); renderHomeDynamic(); }
});
$("#blank-btn").addEventListener("click", () => openBlank(location.href));
$("#cloak-now-btn").addEventListener("click", () => { applyCloak(); toast(`Tab disguised as “${document.title}” 🥷`); });
$("#hint-cloak").addEventListener("click", () => { applyCloak(); toast(`Tab disguised as “${document.title}” 🥷`); });
$("#hint-engines").addEventListener("click", () => showView("settings"));

async function refreshNetStats() {
  // Exit IP (best-effort)
  fetch("/api/egress").then((r) => r.json()).then((d) => {
    $("#stat-egress").textContent = d.ip || "—";
  }).catch(() => { $("#stat-egress").textContent = "—"; });
  // Wisp ping
  const ms = await proxy.pingWisp();
  $("#stat-wisp").textContent = ms === null ? "unreachable" : `${ms} ms`;
}

/* Play */
let playFilter = { cat: "All", q: "" };
function renderPlay() {
  const cats = ["All", ...new Set(GAMES.map((g) => g.cat)), "Built-in"];
  $("#play-chips").innerHTML = cats.map((c) =>
    `<button class="chip${playFilter.cat === c ? " active" : ""}" data-c="${esc(c)}">${esc(c)}</button>`).join("");
  $$("#play-chips .chip").forEach((b) => b.addEventListener("click", () => { playFilter.cat = b.dataset.c; renderPlay(); }));
  const list = GAMES.filter((g) =>
    (playFilter.cat === "All" || (playFilter.cat === "Built-in" ? g.kind === "builtin" : g.cat === playFilter.cat)) &&
    (g.name + " " + g.desc).toLowerCase().includes(playFilter.q.toLowerCase()));
  $("#play-grid").replaceChildren(...list.map((g) =>
    tile({ name: g.name, desc: g.desc, icon: g.emoji, badge: g.kind === "builtin" ? "BUILT-IN" : "PROXY", badgeClass: g.kind === "builtin" ? "" : "proxy" },
      () => g.kind === "builtin" ? openGame(g) : openInBrowser(g.target))));
}
$("#play-search").addEventListener("input", (e) => { playFilter.q = e.target.value; renderPlay(); });

let currentGame = null;
function openGame(g) {
  currentGame = g;
  $("#game-title").textContent = `${g.emoji} ${g.name}`;
  $("#game-frame").src = g.target;
  $("#game-overlay").hidden = false;
  $("#game-frame").focus();
}
$("#game-close").addEventListener("click", closeGame);
function closeGame() {
  $("#game-overlay").hidden = true;
  $("#game-frame").src = "about:blank";
  currentGame = null;
}
$("#game-fs").addEventListener("click", () => $("#game-frame").requestFullscreen?.().catch(() => {}));
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data || typeof e.data !== "object") return;
  // Only the actual game iframe may award coins — proxied pages are also
  // same-origin (under /lessons/) and could otherwise farm by postMessage.
  if (e.source !== $("#game-frame").contentWindow) return;
  if (typeof e.data.pineCoins === "number" && e.data.pineCoins > 0 && currentGame)
    earn(Math.min(50, Math.floor(e.data.pineCoins)), "games", currentGame.name);
  if (e.data.pineCloseGame) closeGame();
});

/* Apps */
let appsFilter = { cat: "All", q: "" };
function renderApps() {
  const cats = ["All", ...new Set(APPS.map((a) => a.cat))];
  $("#apps-chips").innerHTML = cats.map((c) =>
    `<button class="chip${appsFilter.cat === c ? " active" : ""}" data-c="${esc(c)}">${esc(c)}</button>`).join("");
  $$("#apps-chips .chip").forEach((b) => b.addEventListener("click", () => { appsFilter.cat = b.dataset.c; renderApps(); }));
  const list = APPS.filter((a) =>
    (appsFilter.cat === "All" || a.cat === appsFilter.cat) &&
    (a.name + " " + a.desc + " " + hostOf(a.url)).toLowerCase().includes(appsFilter.q.toLowerCase()));
  $("#apps-grid").replaceChildren(...list.map(appTile));
}
$("#apps-search").addEventListener("input", (e) => { appsFilter.q = e.target.value; renderApps(); });

/* Watch + Listen catalogues */
let watchService = "youtube";
const WATCH_SEARCH = {
  youtube: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  twitch: (q) => `https://www.twitch.tv/search?term=${encodeURIComponent(q)}`,
  tiktok: (q) => `https://www.tiktok.com/search?q=${encodeURIComponent(q)}`,
  dailymotion: (q) => `https://www.dailymotion.com/search/${encodeURIComponent(q)}`,
};
$("#watch-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ws]");
  if (!b) return;
  watchService = b.dataset.ws;
  $$("#watch-chips .chip").forEach((c) => c.classList.toggle("active", c === b));
  $("#watch-input").placeholder = `Search ${b.textContent}… or paste a video URL`;
});
$("#watch-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#watch-input").value.trim();
  if (!v) return;
  if (/^https?:\/\//i.test(v) || (!/\s/.test(v) && v.includes("."))) openInBrowser(v);
  else openInBrowser(WATCH_SEARCH[watchService](v));
});

/* Music */
function renderListen() {
  $("#stations-grid").replaceChildren(...STATIONS.map((s) => {
    const t = tile({ name: s.name, desc: s.desc, icon: s.emoji, badge: "PINE FM" }, async () => {
      try { await music.play(s.id); } catch { toast("Audio couldn't start in this browser.", "err"); }
    });
    t.dataset.station = s.id;
    if (music.playing === s.id) t.classList.add("playing");
    return t;
  }));
  $("#listen-grid").replaceChildren(...LISTEN_SERVICES.map(appTile));
}
music.onState = (id, track) => {
  const bar = $("#playerbar");
  bar.hidden = !id;
  if (id) {
    const st = STATIONS.find((s) => s.id === id);
    $("#np-station").textContent = st ? `${st.emoji} ${st.name}` : "Pine FM";
    $("#np-track").textContent = track ? `♪ ${track}` : "";
    $("#np-toggle-use").setAttribute("href", "#i-pause");
    startViz();
  }
  $$("#stations-grid .tile").forEach((t) => t.classList.toggle("playing", t.dataset.station === id));
};
$("#np-toggle").addEventListener("click", async () => {
  if (!music.playing) return;
  if (music.ctx.state === "running") { await music.ctx.suspend(); $("#np-toggle-use").setAttribute("href", "#i-tri"); }
  else { await music.ctx.resume(); $("#np-toggle-use").setAttribute("href", "#i-pause"); }
});
$("#np-stop").addEventListener("click", () => music.stop());
$("#np-vol").addEventListener("input", (e) => music.setVolume(e.target.value / 100));
let vizRunning = false;
function startViz() {
  if (vizRunning) return;
  vizRunning = true;
  const canvas = $("#viz");
  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(64);
  const draw = () => {
    if (!music.playing) { vizRunning = false; return; }
    requestAnimationFrame(draw);
    if (!music.analyser) return;
    music.analyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const style = getComputedStyle(document.documentElement);
    ctx.fillStyle = style.getPropertyValue("--acc").trim() || "#35d07f";
    const bars = 12;
    for (let i = 0; i < bars; i++) {
      const v = data[Math.floor(i * 2.2)] / 255;
      const h = Math.max(2, v * canvas.height);
      ctx.fillRect(i * (canvas.width / bars) + 1, canvas.height - h, canvas.width / bars - 2, h);
    }
  };
  draw();
}

/* ------------------------------------------------------------------ */
/* Chat                                                               */
/* ------------------------------------------------------------------ */
let chat = null, myChatId = null, chatRooms = [], chatRoomNow = "lobby";
function badgeIcon(b) { return BADGE_ICONS[b] ? ` <span class="badge-ic" title="${b} badge">${BADGE_ICONS[b]}</span>` : ""; }
function linkifyAndEscape(text) {
  return esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="#" data-open-url="$1" rel="noreferrer">$1</a>');
}
function renderChatEvent(ev) {
  const box = $("#chat-messages");
  if (ev.t === "hello") {
    myChatId = ev.id;
    chatRooms = ev.rooms || [];
    renderRooms();
    return;
  }
  if (ev.t === "rooms") { chatRooms = ev.rooms; renderRooms(); return; }
  if (ev.t === "joined") {
    chatRoomNow = ev.room;
    $("#chat-room-now").textContent = ev.room;
    $("#chat-input").placeholder = `Message #${ev.room}…`;
    box.innerHTML = "";
    for (const h of ev.history || []) renderChatEvent(h);
    renderRooms();
    return;
  }
  if (ev.t === "presence") {
    if (ev.room !== chatRoomNow) return;
    $("#chat-users").innerHTML = (ev.users || []).map((u) =>
      `<div class="user-item" style="color:${esc(u.color || "inherit")}">${esc(u.name)}${badgeIcon(u.badge)}</div>`).join("") || '<div class="fineprint">Just you 🌲</div>';
    $("#chat-dot").hidden = (ev.count || 0) <= 1;
    return;
  }
  if (ev.t === "system" || ev.t === "notice") {
    const d = document.createElement("div");
    d.className = `msg ${ev.t}`;
    d.textContent = ev.text;
    box.appendChild(d);
  } else if (ev.t === "msg") {
    if (ev.room !== chatRoomNow) return;
    const d = document.createElement("div");
    d.className = "msg";
    const time = new Date(ev.ts || Date.now()).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const imgMatch = /^https?:\/\/[^\s]+\.(png|jpe?g|gif|webp)(\?[^\s]*)?$/i.test(ev.text.trim());
    const canImage = imgMatch && (ev.badge === "diamond" || ev.badge === "crown");
    d.innerHTML =
      `<div class="msg-head"><b style="color:${esc(ev.color || "inherit")}">${esc(ev.name)}</b>${badgeIcon(ev.badge)}<time>${time}</time></div>` +
      `<div class="msg-text">${linkifyAndEscape(ev.text)}${canImage ? `<img class="chat-img" src="${esc(ev.text.trim())}" alt="image shared in chat" loading="lazy">` : ""}</div>`;
    box.appendChild(d);
    if (ev.id && ev.id === myChatId) earn(1, "chat");
  } else {
    return;
  }
  while (box.children.length > 220) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
function renderRooms() {
  $("#chat-rooms").innerHTML = chatRooms.map((r) =>
    `<button class="room-item${r.name === chatRoomNow ? " active" : ""}" data-room="${esc(r.name)}">#${esc(r.name)}<span class="count">${r.count}</span></button>`).join("");
  $$("#chat-rooms .room-item").forEach((b) => b.addEventListener("click", () => chat?.join(b.dataset.room)));
}
function initChat() {
  chat = new ChatClient({
    onEvent: renderChatEvent,
    onStatus: (s) => {
      const el = $("#chat-status");
      el.innerHTML = `<span class="dot ${s === "online" ? "dot-ready" : s === "connecting" ? "dot-loading" : "dot-error"}"></span>${s}`;
    },
  });
  chat.connect("lobby");
}
$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const v = input.value.trim();
  if (!v) return;
  if (!chat?.connected) { toast("Chat is reconnecting…", "err"); chat?.connect(chatRoomNow); return; }
  chat.sendMessage(v);
  input.value = "";
});
$("#chat-room-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#chat-newroom").value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "");
  if (v) { chat?.join(v); $("#chat-newroom").value = ""; }
});
$("#chat-messages").addEventListener("click", (e) => {
  const a = e.target.closest("[data-open-url]");
  if (a) { e.preventDefault(); openInBrowser(a.dataset.openUrl); }
});

/* ------------------------------------------------------------------ */
/* AI                                                                 */
/* ------------------------------------------------------------------ */
function aiRender(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}
function aiSay(role, text, actions, via) {
  const box = $("#ai-messages");
  const d = document.createElement("div");
  d.className = `ai-msg ${role}`;
  d.innerHTML = aiRender(text) +
    (actions?.length ? `<span class="ai-actions">${actions.map((a, i) => `<button class="ai-action" data-ai-act="${i}">${esc(a.label)}</button>`).join("")}</span>` : "") +
    (via ? `<span class="via">${via === "api" ? "your model" : via === "web" ? "web lookup · DuckDuckGo" : "pine local brain"}</span>` : "");
  if (actions?.length) {
    $$(".ai-action", d).forEach((b) => b.addEventListener("click", () => {
      const a = actions[Number(b.dataset.aiAct)];
      if (a.url) openInBrowser(a.url);
      else if (a.search) openInBrowser(normaliseInput(a.search, state.settings.search));
    }));
  }
  box.appendChild(d);
  d.scrollIntoView({ behavior: "smooth", block: "end" });
  return d;
}
async function aiAsk(q) {
  aiSay("me", q);
  const typing = aiSay("bot", "");
  typing.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  try {
    const ans = await askAI(q, state.settings);
    typing.remove();
    aiSay("bot", ans.text, ans.actions, ans.via || "local");
    earn(1, "ai");
  } catch {
    typing.innerHTML = "Something snapped. Try again in a moment.";
  }
}
$("#ai-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#ai-input");
  const v = input.value.trim();
  if (!v) return;
  input.value = "";
  aiAsk(v);
});
$("#ai-chips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-q]");
  if (b) aiAsk(b.dataset.q);
});
$("#ai-clear").addEventListener("click", () => { $("#ai-messages").innerHTML = ""; resetAI(); aiWelcome(); });
function aiWelcome() {
  aiSay("bot", "Hey 🌲 Ask me maths (`15% of 230`), a conversion (`5 km to miles`), or a general question and I'll look it up with sources.", null, "local");
}

/* ------------------------------------------------------------------ */
/* Modals: shop / Pro, history, shortcuts, confirm                    */
/* ------------------------------------------------------------------ */
function openModal(html) {
  closeModal();
  const back = document.createElement("div");
  back.className = "modal-back";
  back.id = "modal-back";
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  back.addEventListener("mousedown", (e) => { if (e.target === back) closeModal(); });
  $("#modal-root").appendChild(back);
  return back.querySelector(".modal");
}
function closeModal() { $("#modal-back")?.remove(); }
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeModal(); menu.hidden = true; if (!$("#game-overlay").hidden) closeGame(); }
});
function modalHead(title) {
  return `<div class="modal-head"><h3>${title}</h3><button class="icon-btn" data-close-modal aria-label="Close"><svg><use href="#i-x"/></svg></button></div>`;
}
document.addEventListener("click", (e) => { if (e.target.closest("[data-close-modal]")) closeModal(); });

function confirmModal(text, okLabel = "Yes, do it") {
  return new Promise((resolve) => {
    const m = openModal(`${modalHead("Are you sure?")}<p style="color:var(--tx-2);line-height:1.6">${esc(text)}</p>
      <div class="btn-row" style="justify-content:flex-end"><button class="btn" data-c="no">Cancel</button><button class="btn btn-acc" data-c="yes">${esc(okLabel)}</button></div>`);
    m.addEventListener("click", (e) => {
      const b = e.target.closest("[data-c]");
      if (b) { closeModal(); resolve(b.dataset.c === "yes"); }
      if (e.target.closest("[data-close-modal]")) resolve(false);
    });
  });
}

function openProShop() {
  const p = state.profile, w = state.wallet;
  const itemRow = (item) => {
    const owned = owns(item.id);
    const equipped =
      (item.kind === "badge" && p.badge === item.value) ||
      (item.kind === "theme" && state.settings.theme === item.value) ||
      (item.kind === "effect" && p.effect === item.value);
    return `<div class="shop-item"><div class="si-meta"><b>${esc(item.name)}</b><span>${esc(item.desc)}</span></div>` +
      (equipped ? `<span class="pill">Equipped ✓</span>`
        : owned ? `<button class="btn sm btn-acc" data-equip="${item.id}">Equip</button>`
        : `<button class="btn sm" data-buy="${item.id}" ${w.coins < item.price ? "disabled" : ""}>🪙 ${item.price.toLocaleString()}</button>`) +
      `</div>`;
  };
  const m = openModal(`
    ${modalHead("◆ Pine Pro & shop")}
    <div class="pro-hero"><div class="big">pine <em style="color:var(--acc)">pro</em></div>
    <p style="color:var(--tx-2);margin:.3rem 0">Everything, on every site — louder.</p></div>
    <ul class="pro-perks">
      <li><b>2,000 coins a day</b> daily claim</li>
      <li><b>2× coins</b> on everything you earn</li>
      <li><b>Diamond badge</b> + name colours</li>
      <li><b>Profile effects</b> &amp; glow</li>
      <li><b>Images in chat</b> (with diamond+)</li>
      <li><b>No ads</b> (there are none anyway)</li>
    </ul>
    <p style="text-align:center">Balance: <b style="color:var(--amber)">🪙 ${w.coins.toLocaleString()}</b></p>
    ${p.pro
      ? `<p style="text-align:center;color:var(--acc);font-weight:700">You're Pine Pro ◆ — legendary.</p>`
      : `<div style="text-align:center"><button class="btn btn-acc" id="buy-pro" ${w.coins < PRO_PRICE ? "disabled" : ""}>Unlock Pro — 🪙 ${PRO_PRICE.toLocaleString()}</button>
         ${w.coins < PRO_PRICE ? `<p class="fineprint">Earn coins from daily claims, built-in games (Coin Clicker!), chatting and browsing.</p>` : ""}</div>`}
    <hr class="set-hr">
    <h4 style="margin:.2rem 0 .4rem">Shop</h4>
    <div class="shop-grid">${SHOP.map(itemRow).join("")}</div>`);
  m.addEventListener("click", (e) => {
    const buyId = e.target.closest("[data-buy]")?.dataset.buy;
    const equipId = e.target.closest("[data-equip]")?.dataset.equip;
    if (e.target.id === "buy-pro") {
      if (spend(PRO_PRICE)) {
        state.profile.pro = true;
        if (!owns("badge-diamond")) state.wallet.owned.push("badge-diamond");
        state.profile.badge = "diamond";
        save();
        toast("Welcome to Pine Pro ◆");
        renderHeader();
        openProShop();
      }
      return;
    }
    const item = SHOP.find((s) => s.id === (buyId || equipId));
    if (!item) return;
    if (buyId) {
      if (!spend(item.price)) return toast("Not enough coins yet 🪙", "err");
      state.wallet.owned.push(item.id);
      toast(`${item.name} unlocked!`);
    }
    // equip
    if (item.kind === "badge") state.profile.badge = item.value;
    if (item.kind === "theme") { state.settings.theme = item.value; applyTheme(); }
    if (item.kind === "effect") state.profile.effect = item.value;
    save();
    renderHeader();
    chat?.syncProfile();
    openProShop();
  });
}
$("#pro-btn").addEventListener("click", openProShop);
$("#coins-chip").addEventListener("click", openProShop);

function openHistoryModal() {
  const row = (e2) =>
    `<button class="hist-item" data-u="${esc(e2.url)}"><img src="${esc(faviconFor(e2.url))}" alt="" loading="lazy" onerror="this.remove()">` +
    `<span class="h-meta"><b>${esc(e2.title)}</b><span>${esc(e2.url)}</span></span></button>`;
  const m = openModal(`${modalHead("History & bookmarks")}
    <div style="max-height:60dvh;overflow-y:auto">
      ${state.bookmarks.length ? `<h4>⭐ Bookmarks</h4>${state.bookmarks.map(row).join("")}` : ""}
      <h4>${state.bookmarks.length ? "🕘" : ""} History</h4>
      ${state.history.length ? state.history.slice(0, 80).map(row).join("") : '<p class="fineprint">Nothing yet — go explore 🌲</p>'}
    </div>
    <div class="btn-row"><button class="btn sm danger" id="hist-clear">Clear history</button></div>`);
  m.addEventListener("click", (e) => {
    const b = e.target.closest("[data-u]");
    if (b) { closeModal(); openInBrowser(b.dataset.u); }
    if (e.target.id === "hist-clear") { state.history = []; save(); closeModal(); toast("History cleared"); }
  });
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */
const AVATARS = ["🌲", "🦊", "🐸", "🦉", "🐼", "🦄", "🤖", "😎", "🔥", "🍄", "🍃", "⭐"];
function renderHeader() {
  const p = state.profile;
  $("#coins-count").textContent = state.wallet.coins.toLocaleString();
  $("#profile-name").textContent = p.name;
  $("#profile-level").textContent = `Lv ${level().level}${p.pro ? " ◆ PRO" : ""}`;
  const av = $("#avatar");
  av.textContent = p.avatar;
  av.className = `avatar ${p.effect !== "none" ? "fx-" + p.effect : ""}`;
  const lvl = level();
  const bar = $("#set-xp-bar");
  if (bar) {
    bar.style.width = lvl.pct + "%";
    $("#set-level-text").textContent = `Level ${lvl.level}`;
    $("#set-xp-text").textContent = `${state.wallet.xp.toLocaleString()} xp total`;
  }
}
subscribe(renderHeader);

function refreshSettings() {
  const s = state.settings;
  $("#set-name").value = state.profile.name === "guest" ? "" : state.profile.name;
  // avatars
  $("#set-avatars").innerHTML = AVATARS.map((a) =>
    `<button type="button" class="swatch${state.profile.avatar === a ? " sel" : ""}" data-av="${a}">${a}</button>`).join("");
  // colors (last 3 are Pro)
  $("#set-colors").innerHTML = NAME_COLORS.map((c, i) =>
    `<button type="button" class="swatch${state.profile.color === c ? " sel" : ""}" data-col="${c}" style="background:${c}" title="${i >= NAME_COLORS.length - 3 ? "Pine Pro colour" : c}">${i >= NAME_COLORS.length - 3 && !state.profile.pro ? "🔒" : ""}</button>`).join("");
  // badges
  const badge = $("#set-badge");
  badge.innerHTML = `<option value="none">None</option>` + ["leaf", "star", "diamond", "crown"].map((b) => {
    const item = SHOP.find((x) => x.value === b && x.kind === "badge");
    const have = owns(item?.id || "");
    return `<option value="${b}" ${have ? "" : "disabled"}>${BADGE_ICONS[b]} ${b[0].toUpperCase() + b.slice(1)}${have ? "" : ` — 🪙${item?.price} in shop`}</option>`;
  }).join("");
  badge.value = state.profile.badge;
  $("#set-effect").value = state.profile.effect;
  $("#set-engine").value = s.engine;
  $("#set-transport").value = s.transport;
  const searchSel = $("#set-search");
  if (!searchSel.options.length)
    searchSel.innerHTML = Object.entries(SEARCH_ENGINES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  searchSel.value = s.search;
  $("#set-wisp").value = s.customWisp;
  const cloakSel = $("#set-cloak");
  if (!cloakSel.options.length)
    cloakSel.innerHTML = Object.entries(CLOAKS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  cloakSel.value = s.cloakPreset;
  $("#set-cloak-title").value = s.cloakTitle;
  $("#set-cloak-icon").value = s.cloakIcon;
  $("#set-cloak-hide").checked = s.cloakOnHide;
  $("#set-panic-key").value = s.panicKey;
  $("#set-panic-url").value = s.panicUrl;
  const themeSel = $("#set-theme");
  themeSel.innerHTML = Object.entries(THEMES).map(([k, v]) => {
    const locked = v.price > 0 && !owns(`theme-${k}`);
    return `<option value="${k}">${v.label}${locked ? ` 🔒 🪙${v.price}` : ""}</option>`;
  }).join("");
  themeSel.value = s.theme;
  $("#set-motion").checked = s.reduceMotion;
  $("#set-ai-base").value = s.aiBase;
  $("#set-ai-key").value = s.aiKey;
  $("#set-ai-model").value = s.aiModel;
  renderHeader();
  fetch("/api/stats").then((r) => r.json()).then((d) => {
    $("#server-stats").textContent =
      `Pine ${"v1.0.0"} · up ${Math.floor(d.uptime / 3600)}h ${Math.floor((d.uptime % 3600) / 60)}m · ${d.requests} requests · ${d.memoryMB} MB · chat: ${d.chat.inRooms} in rooms`;
    $("#ver").textContent = "v1.0.0";
  }).catch(() => { $("#server-stats").textContent = "Couldn't reach the server API."; });
}

/* settings events (delegated where re-rendered) */
$("#set-name").addEventListener("change", (e) => {
  state.profile.name = e.target.value.trim().slice(0, 24) || "guest";
  save(); renderHeader(); chat?.syncProfile(); renderHomeDynamic();
});
$("#set-avatars").addEventListener("click", (e) => {
  const b = e.target.closest("[data-av]");
  if (b) { state.profile.avatar = b.dataset.av; save(); refreshSettings(); }
});
$("#set-colors").addEventListener("click", (e) => {
  const b = e.target.closest("[data-col]");
  if (!b) return;
  const proOnly = NAME_COLORS.slice(-3).includes(b.dataset.col);
  if (proOnly && !state.profile.pro) { toast("That colour is a Pine Pro perk ◆", "err"); openProShop(); return; }
  state.profile.color = b.dataset.col; save(); refreshSettings(); chat?.syncProfile();
});
$("#set-badge").addEventListener("change", (e) => { state.profile.badge = e.target.value; save(); chat?.syncProfile(); });
$("#set-effect").addEventListener("change", (e) => {
  const v = e.target.value;
  if (v !== "none" && !owns(`effect-${v}`)) { toast("That effect is in the shop 🪙", "err"); e.target.value = state.profile.effect; openProShop(); return; }
  state.profile.effect = v; save(); renderHeader();
});
$("#set-engine").addEventListener("change", (e) => { state.settings.engine = e.target.value; save(); $("#hint-engine-name").textContent = ENGINE_LABELS[e.target.value]; toast(`New tabs will use ${ENGINE_LABELS[e.target.value]}`); });
$("#set-transport").addEventListener("change", async (e) => {
  state.settings.transport = e.target.value; save();
  $("#status-transport").textContent = e.target.value;
  $("#stat-proxy-sub").textContent = `Scramjet · ${e.target.value} transport`;
  if (proxy.ready) {
    toast(`Switching transport to ${e.target.value}…`);
    try { await proxy.setTransport(e.target.value, state.settings.customWisp); toast("Transport switched ✓ Open tabs keep working."); }
    catch { toast("Transport switch failed — will retry on next navigation.", "err"); }
  }
});
$("#set-search").addEventListener("change", (e) => { state.settings.search = e.target.value; save(); });
$("#set-wisp").addEventListener("change", (e) => { state.settings.customWisp = e.target.value.trim(); save(); proxy.wispUrl = defaultWispUrl(state.settings.customWisp); toast("Wisp server saved — applies to the next transport switch or restart of the engine."); });
$("#wisp-test").addEventListener("click", async () => {
  const url = defaultWispUrl($("#set-wisp").value);
  $("#wisp-test-out").textContent = `Testing ${url} …`;
  const old = proxy.wispUrl;
  proxy.wispUrl = url;
  const ms = await proxy.pingWisp();
  proxy.wispUrl = old;
  $("#wisp-test-out").textContent = ms === null ? "❌ No answer from that Wisp server." : `✅ Answered in ${ms} ms.`;
});
$("#set-cloak").addEventListener("change", (e) => { state.settings.cloakPreset = e.target.value; save(); applyCloak(); });
$("#set-cloak-title").addEventListener("change", (e) => { state.settings.cloakTitle = e.target.value.trim(); save(); applyCloak(); });
$("#set-cloak-icon").addEventListener("change", (e) => { state.settings.cloakIcon = e.target.value.trim(); save(); applyCloak(); });
$("#set-cloak-hide").addEventListener("change", (e) => { state.settings.cloakOnHide = e.target.checked; save(); });
$("#set-cloak-apply").addEventListener("click", () => { applyCloak(); toast(`This tab now looks like “${document.title}”`); });
$("#set-blank").addEventListener("click", () => openBlank(location.href));
$("#set-panic-key").addEventListener("change", (e) => { state.settings.panicKey = e.target.value; save(); });
$("#set-panic-url").addEventListener("change", (e) => { state.settings.panicUrl = e.target.value.trim() || "https://classroom.google.com"; save(); });
$("#set-theme").addEventListener("change", (e) => {
  const k = e.target.value;
  if (THEMES[k]?.price > 0 && !owns(`theme-${k}`)) {
    toast("That theme unlocks in the shop 🪙", "err");
    e.target.value = state.settings.theme;
    openProShop();
    return;
  }
  state.settings.theme = k; save(); applyTheme();
});
$("#set-motion").addEventListener("change", (e) => { state.settings.reduceMotion = e.target.checked; save(); applyTheme(); });
$("#open-shop-2").addEventListener("click", openProShop);
$("#set-ai-base").addEventListener("change", (e) => { state.settings.aiBase = e.target.value.trim(); save(); });
$("#set-ai-key").addEventListener("change", (e) => { state.settings.aiKey = e.target.value.trim(); save(); toast(state.settings.aiKey ? "AI key saved (browser-only) ✓" : "AI key cleared"); updateAiNote(); });
$("#set-ai-model").addEventListener("change", (e) => { state.settings.aiModel = e.target.value.trim(); save(); });
function updateAiNote() {
  $("#ai-note").textContent = state.settings.aiKey
    ? `Using your model (${state.settings.aiModel || "gpt-4o-mini"}) — the key never leaves this browser.`
    : "Local maths + conversions + web lookups. Add an API key in Settings for a full model.";
}
$("#proxy-reset").addEventListener("click", async () => {
  if (!(await confirmModal("This unregisters the proxy service worker and clears Scramjet cookies (you'll be signed out of proxied sites), caches, then reloads Pine.", "Reset proxy"))) return;
  await proxy.reset();
  toast("Proxy reset — reloading…");
  setTimeout(() => location.reload(), 600);
});
$("#data-history").addEventListener("click", openHistoryModal);
$("#data-clear-history").addEventListener("click", async () => {
  if (await confirmModal("Clear all browsing history stored in this browser? Bookmarks stay.")) { state.history = []; save(); renderHomeDynamic(); toast("History cleared"); }
});
$("#data-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "pine-settings.json";
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#data-import").addEventListener("click", () => $("#data-import-file").click());
$("#data-import-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    for (const k of ["settings", "profile", "wallet"]) if (parsed[k]) Object.assign(state[k], parsed[k]);
    for (const k of ["history", "bookmarks"]) if (Array.isArray(parsed[k])) state[k] = parsed[k];
    save(); applyTheme(); applyCloak(); renderHeader(); refreshSettings(); renderHomeDynamic();
    toast("Settings imported ✓");
  } catch { toast("That file didn't look like Pine settings.", "err"); }
  e.target.value = "";
});
$("#data-reset").addEventListener("click", async () => {
  if (!(await confirmModal("Reset EVERYTHING: profile, coins, shop purchases, settings, history, bookmarks — plus proxy cookies. This can't be undone.", "Reset everything"))) return;
  resetAll();
  await proxy.reset();
  location.reload();
});
$("#shortcuts-btn").addEventListener("click", () => {
  openModal(`${modalHead("Keyboard shortcuts")}
    <div style="line-height:2;color:var(--tx-2)">
      <div><code>Ctrl/⌘ K</code> — jump to search</div>
      <div><code>/</code> — focus search (on Home)</div>
      <div><code>Alt T</code> — new browser tab · <code>Alt W</code> — close tab</div>
      <div><code>Ctrl/⌘ L</code> — address bar (in Browse)</div>
      <div><code>1–8</code> with <code>Alt</code> — jump between sections</div>
      <div><code>${esc(state.settings.panicKey === "Escape" ? "Esc" : state.settings.panicKey)}</code> — panic (instant exit, configurable)</div>
      <div><code>Esc</code> — close dialogs &amp; games</div>
    </div>`);
});

/* ------------------------------------------------------------------ */
/* Header, clock, keyboard                                            */
/* ------------------------------------------------------------------ */
$("#profile-chip").addEventListener("click", () => showView("settings"));
$("#proxy-pill").addEventListener("click", () => showView("settings"));
proxy.onStatus((s) => {
  const dot = $("#proxy-pill .dot");
  dot.className = `dot dot-${s}`;
  $("#proxy-pill-text").textContent = { idle: "proxy idle", loading: "starting proxy…", ready: "proxy ready", error: "proxy error" }[s] || s;
  $("#stat-proxy").textContent = { idle: "idle (starts on first browse)", loading: "starting…", ready: "ready ✓", error: "failed to start" }[s] || s;
});
function tickClock() {
  $("#clock").textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
setInterval(tickClock, 10000);
if (navigator.getBattery) {
  navigator.getBattery().then((b) => {
    const el = $("#battery");
    const upd = () => { el.hidden = false; el.textContent = `${Math.round(b.level * 100)}%${b.charging ? " ⚡" : ""}`; };
    upd();
    b.addEventListener("levelchange", upd);
    b.addEventListener("chargingchange", upd);
  }).catch(() => {});
}
const VIEW_ORDER = ["home", "play", "apps", "chat", "ai", "listen", "watch", "browse"];
document.addEventListener("keydown", (e) => {
  const pk = state.settings.panicKey;
  // If Esc is the panic key, let it close dialogs/games first — panic on the *next* press.
  const escBusy = pk === "Escape" && (document.querySelector("#modal-back") || !$("#game-overlay").hidden);
  // Non-typing panic keys (Esc/F9) must work even mid-keystroke in an input —
  // that's exactly when you'd need them. Printable keys respect text fields.
  const panicWhileEditing = pk === "Escape" || pk === "F9";
  if (pk && e.key === pk && !escBusy && (panicWhileEditing || !isEditing()) && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); panic(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (currentView === "browse") $("#addr-input").focus();
    else { showView("home"); $("#home-input").focus(); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l" && currentView === "browse") {
    e.preventDefault(); $("#addr-input").select(); return;
  }
  if (e.altKey && isEditing()) return; // don't hijack Alt combos mid-typing (accents et al.)
  if (e.altKey && /^[1-8]$/.test(e.key)) { e.preventDefault(); showView(VIEW_ORDER[Number(e.key) - 1]); return; }
  if (e.altKey && e.key.toLowerCase() === "t") { e.preventDefault(); showView("browse"); createTab({}); $("#addr-input").focus(); return; }
  if (e.altKey && e.key.toLowerCase() === "w" && activeTabId) { e.preventDefault(); closeTab(activeTabId); return; }
  if (e.key === "/" && !isEditing() && currentView === "home") { e.preventDefault(); $("#home-input").focus(); }
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
attachOmnibox($("#home-form"), $("#home-input"), $("#home-suggest"), (url) => openInBrowser(url));
$("#watch-grid").replaceChildren(...WATCH_SERVICES.map(appTile));
applyTheme();
applyCloak();
renderHeader();
renderHomeStatic();
renderHomeDynamic();
renderPlay();
renderApps();
renderListen();
aiWelcome();
updateAiNote();
tickClock();
syncBrowserChrome();
proxy.wispUrl = defaultWispUrl(state.settings.customWisp);
$("#stat-proxy-sub").textContent = `Scramjet · ${state.settings.transport} transport`;

const params = new URLSearchParams(location.search);
const goto = params.get("goto");
const hashView = location.hash.replace("#", "");
if (goto) {
  history.replaceState(null, "", location.pathname);
  openInBrowser(goto);
} else if (VIEW_ORDER.includes(hashView) || hashView === "settings") {
  showView(hashView);
} else {
  showView("home");
}

// Warm the proxy in the background so the first click is instant.
const warm = () => proxy.init({ transport: state.settings.transport, customWisp: state.settings.customWisp })
  .then(() => refreshNetStats())
  .catch(() => { /* surfaced when the user actually browses */ });
if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 4000 });
else setTimeout(warm, 1500);

// First-visit welcome.
if (!state.seenIntro) {
  const m = openModal(`
    <div class="pro-hero"><svg style="width:56px;height:56px;color:var(--acc)"><use href="#i-pine"/></svg>
    <div class="big">welcome to <em style="color:var(--acc)">pine.</em></div>
    <p style="color:var(--tx-2);line-height:1.65">Play, chat, listen, watch — and browse
    <b>everything, on every site</b>, through a proper Scramjet proxy.
    Your history, cookies and coins never leave this browser.</p></div>
    <label class="field" style="margin-top:1rem">Pick a display name (for chat)
      <input id="intro-name" type="text" maxlength="24" placeholder="guest">
    </label>
    <div class="btn-row" style="justify-content:center">
      <button class="btn btn-acc" id="intro-go">Start exploring 🌲</button>
    </div>
    <p class="fineprint" style="text-align:center">Tip: the panic key is <code>${esc(state.settings.panicKey)}</code> — it leaves instantly. Cloaks live in Settings.</p>`);
  $("#intro-name", m).addEventListener("keydown", (e) => { if (e.key === "Enter") $("#intro-go", m).click(); });
  $("#intro-go", m).addEventListener("click", () => {
    const name = $("#intro-name", m).value.trim();
    if (name) { state.profile.name = name.slice(0, 24); }
    state.seenIntro = true;
    save();
    renderHeader();
    closeModal();
    toast(`+150 🪙 welcome coins already in your pocket. Daily claim on Home!`);
  });
}
