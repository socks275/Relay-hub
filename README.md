# 🌲 Pine

**Everything, on every site.** Pine is a self-hosted web hub in the style of the classic
school-unblocker sites — **Home · Play · Apps · Chat · AI · Listen · Watch · Browse** — built
around a genuinely excellent proxy: [Scramjet](https://github.com/MercuryWorkshop/scramjet)
(Mercury Workshop's successor to Ultraviolet) tunnelling over
[Wisp](https://github.com/MercuryWorkshop/wisp-protocol), with a server-side Reader engine
as a no-JavaScript fallback.

One Node process serves the hub, the proxy worker, the Wisp tunnel and the chat server.
Your browsing history, cookies, logins, profile and coins never leave your browser.

---

## Quick start

```bash
git clone https://github.com/<you>/Relay-hub.git
cd Relay-hub
npm ci
node server.js
# → http://localhost:3000
```

That's it. The Scramjet bundles are pinned in `package.json` and served locally — nothing is
downloaded at runtime, and there is no build step.

### Docker

```bash
docker build -t pine .
docker run -p 3000:3000 -e PINE_PASS=something-long pine
# or:  docker compose up -d
```

### Deploy

| Host | How |
| --- | --- |
| **Fly.io** | `fly launch --copy-config --now` (uses `fly.toml`) |
| **Render** | New → Blueprint → point at this repo (uses `render.yaml`) |
| **Railway** | New project → Deploy from repo (uses `railway.json`) |
| **Any VPS** | `docker compose up -d`, put Caddy/nginx/Cloudflare in front for TLS |

> A working proxy **requires HTTPS** in production (service workers need a secure context).
> Fly/Render/Railway terminate TLS for you. On `localhost` it works over plain HTTP.

> Deploying publicly? Set `PINE_PASS`. Pine is a general-purpose proxy; run it for people
> you trust, on a host whose abuse policy allows it.

---

## The proxy, in depth

Pine has three engines, switchable per tab:

### 1. Scramjet (default)
Scramjet is an *interception*-based proxy: a service worker captures every request a proxied
page makes, a WASM rewriter rewrites its HTML/CSS/JS in your browser, and a transport carries
the traffic over one encrypted **Wisp** WebSocket to this server, which opens the real TCP
connections. Because rewriting happens client-side and ports/behaviour look like a real browser,
the compatibility list is the best in class — Google, YouTube, Discord, Reddit, ChatGPT,
Spotify, Instagram, GeForce NOW and most other heavy web apps work, **with logins**
(cookies persist per-browser in IndexedDB).

Two transports, hot-swappable in Settings without losing tabs:

- **libcurl** (default) — real curl in WASM: browser-grade TLS fingerprints, HTTP/2, the
  best chance against bot walls.
- **epoxy** — a lighter Rust TLS stack; great fallback when libcurl struggles.

Supporting cast: an HTTP cache plugin for repeat-visit speed, live address-bar sync,
per-tab titles, a navigation watchdog with a friendly "try another engine/transport"
recovery screen, and an optional **custom Wisp server** if you want your tunnel elsewhere.

### 2. Reader
A from-scratch server-side fetch + rewrite engine (`/api/fetch`). The server fetches the page,
strips scripts/trackers, rewrites links/images/CSS/forms back through itself, and presents a
clean reading view. No JS required, works even where WebSockets are blocked, and unwraps
search-result redirectors (Bing/DuckDuckGo/Google) to real destinations.

### 3. Direct
A plain iframe — for sites that happily embed and don't need proxying at all.

### Security

- **SSRF hardening on the Reader engine**: every target is checked at URL level (scheme,
  ports 80/443 only, reserved/internal hostnames, cloud metadata, IP literals in *every*
  notation — `127.1`, `0x7f000001`, `2130706433`, IPv6 incl. `::ffff:`-mapped and NAT64)
  **and again at connect time** through a validating DNS lookup, closing DNS-rebinding.
  Every redirect hop is re-validated.
- **Wisp** refuses private/loopback destinations by default, and supports a hostname
  blocklist (`PINE_BLOCK_HOSTS`) for operators.
- **Optional password gate** for the whole instance (`PINE_PASS`, timing-safe comparison,
  failure lockout), plus per-IP rate limiting on the Reader endpoint.
- Cross-origin isolation via `COOP: same-origin` + `COEP: credentialless`, so Scramjet's
  transports can use threaded WASM without breaking embedded content.
- Proxied cookies live only in the visitor's browser; the server stores nothing per user.

`PINE_ALLOW_PRIVATE=1` relaxes the private-address guards for home-lab use. Never on a
public instance.

---

## The hub

- **Home** — omnibox with live suggestions (history + DuckDuckGo), `!yt`-style bangs,
  Jump-back-in, bookmarks, quick launch, proxy/Wisp/exit-node status, daily coins.
- **Play** — 8 built-in games (Snake, 2048, Blockfall, Breakout, Flappy Pine, Memory Grove,
  Mines, Coin Clicker) that work offline and pay real Pine coins, plus a proxied catalogue
  (Poki, Krunker, Shell Shockers, Minecraft Classic, 1v1.LOL…).
- **Apps** — 44 sites organised by category, all through the proxy.
- **Chat** — real multi-room community chat served by this process: colours, badges,
  presence, history, custom rooms. Chatting earns coins.
- **AI** — a study buddy that works with zero setup: a local maths engine
  (`15% of 230`, `sqrt(144) + 3^4`), unit conversions, and cited web lookups — or plug in
  any OpenAI-compatible API key (stored only in your browser).
- **Listen** — six generative radio stations composed live with WebAudio (lo-fi, felt
  piano, synthwave, rain, waves, café crackle) with a visualiser, plus streaming services
  via proxy.
- **Watch** — service search + tiles (YouTube, Netflix, iPlayer, Twitch…).
- **Browse** — multi-tab browser: per-tab engines, bookmarks, history, fullscreen,
  about:blank pop-outs, shareable `/?goto=` links, error recovery.

### Coins, levels & Pine Pro

Everything funnels into one pocket: daily claims (250 🪙, or 2,000 with Pro), games,
chatting and browsing earn coins; the shop sells chat badges (🍃 ⭐ 💎 👑), themes
(Ember/Rose/Sand) and profile effects. **Pine Pro** (5,000 🪙) doubles earnings, bumps the
daily claim and unlocks the diamond set. No payments, no ads — just the grind.

### Cloaking & panic

- Tab disguises (Google Docs, Classroom, Canvas, Drive, Gmail, Desmos… or fully custom
  title/icon), auto-cloak when the tab is hidden.
- Open Pine — or any tab — inside an `about:blank` page.
- A panic key (default `` ` ``) instantly replaces the page with your chosen site.
- The tab title and on-page study-library copy present as a K-12 practice centre.

---

## Configuration

All optional, from the environment (see `.env.example`):

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `PINE_USER` / `PINE_PASS` | `pine` / *(off)* | Basic-auth gate for the whole site |
| `PINE_ALLOW_PRIVATE` | `0` | Allow private/loopback proxy targets (LAN only!) |
| `PINE_BLOCK_HOSTS` | — | Comma-separated hosts Wisp must refuse |
| `PINE_DNS_SERVERS` | — | Custom DNS for Wisp resolution |
| `PINE_FETCH_TIMEOUT` | `20000` | Reader upstream timeout (ms) |
| `PINE_MAX_HTML` / `PINE_MAX_STREAM` | 8 MB / 64 MB | Reader size caps |
| `PINE_RATE_LIMIT` | `0` | Requests/min/IP on `/api/fetch` (0 = off) |
| `PINE_LOG_LEVEL` | `info` | silent · error · warn · info · debug |
| `PINE_TRUST_PROXY` | `1` | Trust `X-Forwarded-For` for logs/limits |

## Endpoints

```
GET  /                           the hub
GET  /sw.js                      Scramjet service worker
GET  /scram/*, /controller/*, /clients/*   pinned proxy bundles (served locally)
WS   /wisp/                      Wisp tunnel (all Scramjet traffic)
WS   /chat                       community chat
GET  /api/fetch?mode=reader|asset&url=…   Reader engine
GET  /api/config | /api/stats | /api/ping | /api/egress
GET  /api/suggest?q=…            omnibox suggestions
GET  /api/answer?q=…             AI-tab web lookups
GET  /healthz                    liveness probe
```

## Project layout

```
server.js               http server: routing, API, upgrades (wisp + chat)
src/config.js           environment configuration
src/static.js           static serving: etags, brotli/gzip cache, ranges
src/ssrf.js             URL/IP/DNS validation for the Reader engine
src/fetchproxy.js       Reader upstream fetch (redirects, streaming)
src/rewrite.js          Reader HTML/CSS rewriting
src/chat.js             multi-room chat server
public/index.html       the hub shell (all eight views)
public/sw.js            service worker → Scramjet controller
public/css/app.css      design system (5 themes)
public/js/app.js        hub logic: tabs, catalogues, settings, shop
public/js/proxy.js      Scramjet bootstrap, transports, URL handling
public/js/store.js      local-only state: profile, coins, history
public/js/data.js       catalogues: apps, games, services, shop
public/js/music.js      generative WebAudio stations
public/js/ai.js         maths parser, conversions, assistant
public/js/chat.js       chat client
public/games/*.html     8 self-contained built-in games
test/                   node --test: SSRF/rewrite units + full integration
```

## Development

```bash
npm ci
npm test          # 20 tests: units + boot-the-server integration, incl. real Wisp TCP
npm run dev       # watch mode with debug logging
```

The integration suite starts Pine next to a fixture website and verifies the Reader
rewiring, SSRF refusals, chat relay, auth — and carries a real HTTP request through the
Wisp tunnel end-to-end.

## Known limits

Honest ones, inherent to web proxies:

- Some sites fingerprint and refuse datacenter IPs regardless of engine (some banking,
  parts of Google search, aggressive Cloudflare). Trying the other transport, or running
  Pine from a residential connection, fixes most of these.
- DRM video (Netflix/Disney+ playback) may refuse to play inside any proxy.
- Scramjet 2.0 is alpha-line software from Mercury Workshop; Pine pins a **version-matched
  set** (scramjet 2.0.67-alpha.1 · controller 0.0.13 · utils 0.0.3) because the controller
  asserts an exact Scramjet build. Bump all three together.

## Credits & license

Pine stands on [Mercury Workshop](https://github.com/MercuryWorkshop)'s shoulders:
Scramjet, the Wisp protocol, epoxy and libcurl transports — see `NOTICE`.
Pine is **AGPL-3.0** (see `LICENSE`), matching the Scramjet ecosystem: run a modified
version as a service and you must offer your users the source.
