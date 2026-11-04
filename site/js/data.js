/* Relay Hub — catalogues. Data only; rendering lives in app.js. */

export const SEARCH_ENGINES = {
  duckduckgo: { label: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  google: { label: "Google", url: "https://www.google.com/search?q=%s" },
  bing: { label: "Bing", url: "https://www.bing.com/search?q=%s" },
  brave: { label: "Brave", url: "https://search.brave.com/search?q=%s" },
  startpage: { label: "Startpage", url: "https://www.startpage.com/sp/search?query=%s" },
  ecosia: { label: "Ecosia", url: "https://www.ecosia.org/search?q=%s" },
  mojeek: { label: "Mojeek", url: "https://www.mojeek.com/search?q=%s" },
  youtube: { label: "YouTube", url: "https://www.youtube.com/results?search_query=%s" },
  wikipedia: { label: "Wikipedia", url: "https://en.wikipedia.org/w/index.php?search=%s" },
};

export const BANGS = {
  g: "https://www.google.com/search?q=%s",
  ddg: "https://duckduckgo.com/?q=%s",
  bing: "https://www.bing.com/search?q=%s",
  yt: "https://www.youtube.com/results?search_query=%s",
  w: "https://en.wikipedia.org/w/index.php?search=%s",
  gh: "https://github.com/search?q=%s",
  r: "https://www.reddit.com/search?q=%s",
  so: "https://stackoverflow.com/search?q=%s",
  tw: "https://www.twitch.tv/search?term=%s",
  sp: "https://open.spotify.com/search/%s",
  am: "https://www.amazon.com/s?k=%s",
  eb: "https://www.ebay.com/sch/i.html?_nkw=%s",
  img: "https://duckduckgo.com/?iax=images&ia=images&q=%s",
  maps: "https://www.google.com/maps/search/%s",
  define: "https://www.merriam-webster.com/dictionary/%s",
};

/* New-tab quick links. `icon` is drawn as a coloured letter tile so the site
 * ships zero external images and renders instantly offline. */
const Q = (name, url, icon, color) => ({ name, url, icon, color });
export const QUICK_LINKS = [
  Q("YouTube", "https://www.youtube.com", "▶", "#ff4b4b"),
  Q("Google", "https://www.google.com", "G", "#4285f4"),
  Q("ChatGPT", "https://chatgpt.com", "✳", "#10a37f"),
  Q("Discord", "https://discord.com/app", "D", "#5865f2"),
  Q("Reddit", "https://www.reddit.com", "R", "#ff4500"),
  Q("TikTok", "https://www.tiktok.com", "♪", "#25f4ee"),
  Q("Instagram", "https://www.instagram.com", "◎", "#e1306c"),
  Q("Spotify", "https://open.spotify.com", "S", "#1db954"),
  Q("Twitch", "https://www.twitch.tv", "T", "#9146ff"),
  Q("X", "https://x.com", "X", "#e7e9ea"),
  Q("Netflix", "https://www.netflix.com", "N", "#e50914"),
  Q("GitHub", "https://github.com", "⬡", "#f0f6fc"),
  Q("Wikipedia", "https://en.wikipedia.org", "W", "#d7d7d7"),
  Q("Chess.com", "https://www.chess.com", "♞", "#7fa650"),
  Q("Poki", "https://poki.com", "P", "#ffb400"),
  Q("CrazyGames", "https://www.crazygames.com", "C", "#ff6b00"),
  Q("now.gg", "https://now.gg", "▶", "#00c6ff"),
  Q("Photopea", "https://www.photopea.com", "◈", "#6a4c93"),
];

/* Third-party public Wisp endpoints. Relay probes them from the user's own
 * browser and uses the first that answers, because school and office filters
 * routinely block one host while leaving another reachable. */
export const DEFAULT_WISP_ENDPOINTS = Object.freeze([
  "wss://wisp.webmc.fun/",
  "wss://wisp.freewisp.org/",
  "wss://wisp.mercurywork.shop/",
  "wss://wisp.terbiumon.top/wisp/",
  "wss://anura.pro/",
]);

/* Last-resort fetch path for networks where every Wisp endpoint is blocked:
 * public CORS mirrors. They carry less (no cookies, no WebSockets, no
 * streaming media) but they reach plain sites through ordinary HTTPS. */
export const CORS_PROXIES = Object.freeze([
  {
    name: "allorigins",
    build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  },
  {
    name: "codetabs",
    build: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  },
  {
    name: "corsproxy.io",
    build: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  },
  {
    name: "cors.lol",
    build: (u) => `https://api.cors.lol/?url=${encodeURIComponent(u)}`,
  },
  {
    name: "cors.workers.dev",
    build: (u) => `https://test.cors.workers.dev/?${encodeURIComponent(u)}`,
  },
]);

/* Tab-cloak presets: what the browser tab title and favicon look like to
 * anyone glancing at the screen. */
export const CLOAK_PRESETS = Object.freeze([
  { id: "none", label: "Relay Hub", title: "Relay Hub", icon: "favicon.svg" },
  {
    id: "drive",
    label: "Google Drive",
    title: "My Drive - Google Drive",
    icon: "https://www.google.com/s2/favicons?domain=drive.google.com&sz=64",
  },
  {
    id: "docs",
    label: "Google Docs",
    title: "Untitled document - Google Docs",
    icon: "https://www.google.com/s2/favicons?domain=docs.google.com&sz=64",
  },
  {
    id: "classroom",
    label: "Google Classroom",
    title: "Classes",
    icon: "https://www.google.com/s2/favicons?domain=classroom.google.com&sz=64",
  },
  {
    id: "canvas",
    label: "Canvas",
    title: "Dashboard",
    icon: "https://www.google.com/s2/favicons?domain=canvas.instructure.com&sz=64",
  },
  {
    id: "wikipedia",
    label: "Wikipedia",
    title: "Wikipedia, the free encyclopedia",
    icon: "https://www.google.com/s2/favicons?domain=en.wikipedia.org&sz=64",
  },
  {
    id: "blank",
    label: "Blank",
    title: "New Tab",
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
  },
]);

export const THEMES = Object.freeze(["midnight", "aurora", "ember", "sand"]);
