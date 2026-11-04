/* Relay Hub — settings + small persistent lists, in localStorage.
 *
 * Everything is per-browser: Relay Hub has no server, so nothing here ever
 * leaves the machine. Reads are defensive — a corrupt or blocked store
 * degrades to defaults instead of breaking the proxy. */

const KEY = "relay.settings.v1";
const BOOKMARKS = "relay.bookmarks.v1";
const CORS_MEMORY = "relay.cors.v1";

export const DEFAULTS = Object.freeze({
  search: "duckduckgo",
  transport: "libcurl", // libcurl | epoxy
  wisp: "", // blank = probe the public pool
  mode: "auto", // auto | scramjet | simple
  theme: "midnight",
  cloak: "none",
  panicKey: "`",
  suggestions: true,
  openInBlank: false,
});

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — settings stay in memory only */
  }
}

export const settings = {
  get all() {
    return { ...DEFAULTS, ...read(KEY, {}) };
  },
  get(key) {
    const v = read(KEY, {})[key];
    return v === undefined ? DEFAULTS[key] : v;
  },
  set(key, value) {
    const next = { ...read(KEY, {}), [key]: value };
    write(KEY, next);
    return next;
  },
  patch(obj) {
    const next = { ...read(KEY, {}), ...obj };
    write(KEY, next);
    return next;
  },
  reset() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    return { ...DEFAULTS };
  },
};

export const bookmarks = {
  all: () => {
    const list = read(BOOKMARKS, []);
    return Array.isArray(list) ? list : [];
  },
  has: (url) => bookmarks.all().some((b) => b.url === url),
  add(bookmark) {
    const list = bookmarks.all().filter((b) => b.url !== bookmark.url);
    list.unshift(bookmark);
    write(BOOKMARKS, list.slice(0, 200));
    return list;
  },
  remove(url) {
    const list = bookmarks.all().filter((b) => b.url !== url);
    write(BOOKMARKS, list);
    return list;
  },
  clear: () => write(BOOKMARKS, []),
};

/* Which CORS mirror worked last time, so the next fallback skips the ones
 * that failed on this network. */
export const corsMemory = {
  get: () => read(CORS_MEMORY, {}),
  best() {
    const mem = read(CORS_MEMORY, {});
    const entries = Object.entries(mem).filter(([, v]) => typeof v === "number");
    if (!entries.length) return "";
    return entries.sort((a, b) => a[1] - b[1])[0][0];
  },
  record(name, ms) {
    write(CORS_MEMORY, { ...read(CORS_MEMORY, {}), [name]: ms });
  },
  forget(name) {
    const mem = read(CORS_MEMORY, {});
    delete mem[name];
    write(CORS_MEMORY, mem);
  },
  clear: () => write(CORS_MEMORY, {}),
};
