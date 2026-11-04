/* Pine — local state. Everything (settings, profile, coins, history,
 * bookmarks) lives in this browser only. The server never sees it. */

const KEY = "pine.v1";

const defaults = () => ({
  settings: {
    theme: "pine",
    engine: "scramjet",           // scramjet | reader | direct
    transport: "libcurl",         // libcurl | epoxy
    search: "duckduckgo",
    customWisp: "",
    cloakPreset: "none",
    cloakTitle: "",
    cloakIcon: "",
    cloakOnHide: true,
    panicKey: "`",
    panicUrl: "https://classroom.google.com",
    aiKey: "",
    aiBase: "https://api.openai.com",
    aiModel: "gpt-4o-mini",
    reduceMotion: false,
  },
  profile: {
    name: "guest",
    color: "#7ee2a8",
    badge: "none",
    avatar: "🌲",
    effect: "none",
    pro: false,
  },
  wallet: {
    coins: 150,
    xp: 0,
    owned: [],                    // shop item ids
    lastDaily: "",
    earnedToday: {},              // category -> coins earned (day key)
    earnedDay: "",
  },
  history: [],                    // {url, title, ts}
  bookmarks: [],                  // {url, title, ts}
  seenIntro: false,
});

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw);
    const d = defaults();
    // Shallow-merge one level deep so new settings get defaults over time.
    for (const [k, v] of Object.entries(parsed || {})) {
      if (v && typeof v === "object" && !Array.isArray(v) && d[k]) d[k] = { ...d[k], ...v };
      else if (k in d) d[k] = v;
    }
    return d;
  } catch {
    return defaults();
  }
}

export const state = load();
const listeners = new Set();

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
  for (const fn of listeners) fn(state);
}
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ---------------- wallet ---------------- */

const DAILY_CAPS = { browse: 80, chat: 40, games: 400, ai: 30 };

function dayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function earn(amount, category = "misc", reason = "") {
  if (amount <= 0) return 0;
  const w = state.wallet;
  const today = dayKey();
  if (w.earnedDay !== today) { w.earnedDay = today; w.earnedToday = {}; }
  const cap = DAILY_CAPS[category];
  if (cap !== undefined) {
    const used = w.earnedToday[category] || 0;
    amount = Math.min(amount, Math.max(0, cap - used));
    if (amount <= 0) return 0;
    w.earnedToday[category] = used + amount;
  }
  if (state.profile.pro) amount *= 2;
  w.coins += amount;
  w.xp += amount;
  save();
  window.dispatchEvent(new CustomEvent("pine:coins", { detail: { amount, reason, total: w.coins } }));
  return amount;
}

export function spend(amount) {
  if (state.wallet.coins < amount) return false;
  state.wallet.coins -= amount;
  save();
  window.dispatchEvent(new CustomEvent("pine:coins", { detail: { amount: -amount, reason: "shop", total: state.wallet.coins } }));
  return true;
}

export function level() {
  // 100 xp for level 2, each level 1.35× the last.
  let xp = state.wallet.xp, lvl = 1, need = 100;
  while (xp >= need) { xp -= need; lvl++; need = Math.round(need * 1.35); }
  return { level: lvl, into: xp, need, pct: Math.min(100, Math.round((xp / need) * 100)) };
}

export function claimDaily() {
  const today = dayKey();
  if (state.wallet.lastDaily === today) return 0;
  state.wallet.lastDaily = today;
  const amount = state.profile.pro ? 2000 : 250;
  state.wallet.coins += amount;
  state.wallet.xp += amount;
  save();
  window.dispatchEvent(new CustomEvent("pine:coins", { detail: { amount, reason: "daily", total: state.wallet.coins } }));
  return amount;
}

export function owns(itemId) {
  return state.wallet.owned.includes(itemId);
}

/* ---------------- history / bookmarks ---------------- */

export function addHistory(url, title) {
  if (!url || !/^https?:/i.test(url)) return;
  const h = state.history.filter((e) => e.url !== url);
  h.unshift({ url, title: title || hostOf(url), ts: Date.now() });
  state.history = h.slice(0, 200);
  save();
}

export function updateHistoryTitle(url, title) {
  if (!title) return;
  const e = state.history.find((x) => x.url === url);
  if (e && e.title !== title) { e.title = title.slice(0, 120); save(); }
  const b = state.bookmarks.find((x) => x.url === url);
  if (b && b.title === hostOf(url)) { b.title = title.slice(0, 120); save(); }
}

export function isBookmarked(url) {
  return state.bookmarks.some((b) => b.url === url);
}

export function toggleBookmark(url, title) {
  if (isBookmarked(url)) {
    state.bookmarks = state.bookmarks.filter((b) => b.url !== url);
  } else {
    state.bookmarks.unshift({ url, title: title || hostOf(url), ts: Date.now() });
    earn(2, "browse", "bookmark");
  }
  save();
  return isBookmarked(url);
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

export function continueSites(limit = 10) {
  const seen = new Set();
  const out = [];
  for (const e of state.history) {
    const host = hostOf(e.url);
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

export function resetAll() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  Object.assign(state, defaults());
  save();
}
