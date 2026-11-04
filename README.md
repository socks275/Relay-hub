# Relay Hub

**A fast, tabbed web proxy that lives entirely on GitHub.**

No server. No account. No Docker, no Render, no VPS. GitHub Pages serves the
files, your browser runs the proxy, and a Wisp endpoint carries the traffic.

> ### 👉 https://socks275.github.io/Relay-hub/
>
> Open it, type a site or a search, and browse.

---

## What you get

| | |
|---|---|
| **Tabs** | Real multi-tab browsing — open in new tab, middle-click, close, per-tab history |
| **Omnibox** | URLs, search, and `!bangs` (`!yt lo-fi`, `!w python`, `!gh scramjet`) with live suggestions |
| **Two engines** | Scramjet for full browsing, Simple for networks that block everything else |
| **Bookmarks** | Star a page; it shows up on your new-tab page |
| **Quick links** | YouTube, Google, ChatGPT, Discord, Spotify, Poki, now.gg and more |
| **Disguise** | Tab title/favicon presets, a panic key, and an `about:blank` window mode |
| **Themes** | Midnight, Aurora, Ember, Sand |
| **Private by design** | History, cookies, bookmarks and settings never leave your device |

## How a static site can be a proxy

GitHub Pages can't run server code, so Relay Hub does the work in your browser:

```
page → service worker → Scramjet rewriter (WASM) → transport → Wisp → the internet
```

1. **GitHub Pages** serves the page, a service worker, and pinned Scramjet
   bundles. That's all it ever does.
2. **Scramjet** (Mercury Workshop) intercepts and rewrites the proxied site
   inside a tab iframe — cookies, logins, WebSockets, video, apps all work.
3. **libcurl.js** (default) or **epoxy-tls** carries the traffic inside one
   encrypted WebSocket to a **Wisp** endpoint. A network filter sees a single
   connection, not a list of sites. Real curl TLS fingerprints are why these
   proxies survive fingerprint-based filters.
4. **`npm run build`** copies the engine bundles out of `node_modules` into
   `dist/`, so the deployed site fetches nothing at runtime.

### The two engines

| | **Scramjet** (default) | **Simple** (fallback) |
|---|---|---|
| Transport | Wisp over WebSocket | Ordinary HTTPS through public CORS mirrors |
| Logins & cookies | ✅ | ❌ |
| Video, WebSockets, apps | ✅ | ❌ |
| Text, images, links, search | ✅ | ✅ |
| Works when Wisp is blocked | ❌ | ✅ |

**Automatic** mode (the default) uses Scramjet and falls back to Simple if no
Wisp endpoint answers. You can pin either one in **Settings → Engine**, and any
page can be retried in Simple mode from the error banner.

## Deploy it on your own GitHub account

1. **Fork** this repo.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   (The deploy workflow also switches this for you on the first run.)
3. Push to `main`. GitHub Actions builds and publishes to
   `https://<your-username>.github.io/<repo>/`.

That's it — nothing else to configure. The generated site is subpath-safe, so
the same build works at `/`, at `/<repo>/`, or behind a custom domain.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Alt`+`T` | New tab |
| `Alt`+`W` | Close tab |
| `Alt`+`L` | Focus the address bar |
| `Alt`+`R` | Reload |
| `Alt`+`←` / `Alt`+`→` | Back / forward |
| `Alt`+`1`…`9` | Jump to tab |
| `` ` `` (configurable) | Panic — hides Relay instantly |

## Settings

| Setting | What it does |
|---|---|
| Engine | Automatic / Scramjet only / Simple only |
| Transport | libcurl (recommended) / epoxy-tls |
| Wisp endpoint | Blank = probe the public pool and use the fastest; or pin your own `wss://…` and hit **Test** |
| Search engine | DuckDuckGo, Google, Bing, Brave, Startpage, Ecosia, Mojeek, YouTube, Wikipedia |
| Theme / suggestions | Appearance and omnibox behaviour |
| Tab disguise | What the browser tab looks like to someone glancing over |
| Panic key | One keypress to hide Relay behind a blank document |
| Clear browsing data | Drops the service worker, caches and Scramjet's cookie database |

## Local development

```bash
npm ci --ignore-scripts   # fetch the pinned engine bundles
npm run dev               # http://localhost:8080  (no build step needed)
npm run build             # → dist/
npm test                  # unit tests for URL + HTML rewriting and build config
```

`npm run dev` serves `site/` and mounts the same engine bundles the build
copies, so you can edit and reload without rebuilding.

> Service workers need a secure context. `http://localhost` counts as secure,
> so local development is fine; over plain HTTP on another host the browser
> disables service workers and Relay Hub falls back to Simple mode.

## Repo layout

```
site/                 the app (this is what ships)
  index.html  sw.js   shell + Scramjet service worker
  css/app.css         themed interface
  js/urls.js          URL, bang and search resolution (pure, unit-tested)
  js/engine.js        Scramjet boot: service worker, transports, Wisp race
  js/simple.js        CORS fallback engine
  js/rewrite.js       HTML rewriting for Simple mode (pure, unit-tested)
  js/app.js           tabs, navigation, settings, cloaking
scripts/build.mjs     copies site/ + pinned bundles → dist/
scripts/dev-server.mjs  local preview with bundles mounted
test/unit.test.js     Node's built-in test runner
.github/workflows/    CI + Pages deploy
```

## Honest limitations

- **Wisp endpoints are third parties.** They can be busy, rate-limited,
  blocked, or disappear. Relay Hub probes a pool of five and uses the fastest
  that answers from *your* network, which is why it usually just works — but a
  self-hosted endpoint (Settings → Wisp) is the reliable option.
- **A Wisp endpoint sees hostnames.** It connects you to them. Page contents
  stay encrypted end-to-end between your browser and the destination.
- **Simple mode is a fallback**, not an equal: no cookies, no video, no
  WebSockets, and single-page apps generally won't work.
- **GitHub Pages has a soft 1 GB site limit**; the built site is ~6 MB.

## License

AGPL-3.0-only. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
