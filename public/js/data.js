/* Pine — catalogues: apps, games, watch/listen services, search engines,
 * cloak presets, themes and shop items. Everything here is data; rendering
 * lives in app.js. External entries open through the proxy. */

export const SEARCH_ENGINES = {
  duckduckgo: { label: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  google: { label: "Google", url: "https://www.google.com/search?q=%s" },
  bing: { label: "Bing", url: "https://www.bing.com/search?q=%s" },
  brave: { label: "Brave", url: "https://search.brave.com/search?q=%s" },
  startpage: { label: "Startpage", url: "https://www.startpage.com/sp/search?query=%s" },
  ecosia: { label: "Ecosia", url: "https://www.ecosia.org/search?q=%s" },
  youtube: { label: "YouTube", url: "https://www.youtube.com/results?search_query=%s" },
  wikipedia: { label: "Wikipedia", url: "https://en.wikipedia.org/w/index.php?search=%s" },
};

export const BANGS = {
  g: "https://www.google.com/search?q=%s",
  ddg: "https://duckduckgo.com/?q=%s",
  yt: "https://www.youtube.com/results?search_query=%s",
  w: "https://en.wikipedia.org/w/index.php?search=%s",
  gh: "https://github.com/search?q=%s",
  r: "https://www.reddit.com/search?q=%s",
  tw: "https://www.twitch.tv/search?term=%s",
  sp: "https://open.spotify.com/search/%s",
  am: "https://www.amazon.com/s?k=%s",
  img: "https://duckduckgo.com/?iax=images&ia=images&q=%s",
  maps: "https://www.google.com/maps/search/%s",
};

const A = (name, url, cat, desc) => ({ name, url, cat, desc });
export const APPS = [
  A("YouTube", "https://www.youtube.com", "Video", "Videos, shorts and streams"),
  A("Discord", "https://discord.com/app", "Social", "Chat, voice and communities"),
  A("Reddit", "https://www.reddit.com", "Social", "Communities for everything"),
  A("TikTok", "https://www.tiktok.com", "Video", "Short-form video"),
  A("Instagram", "https://www.instagram.com", "Social", "Photos and reels"),
  A("X (Twitter)", "https://x.com", "Social", "The timeline"),
  A("Twitch", "https://www.twitch.tv", "Video", "Live streams and VODs"),
  A("Spotify", "https://open.spotify.com", "Music", "Music and podcasts"),
  A("SoundCloud", "https://soundcloud.com", "Music", "Tracks and mixes"),
  A("ChatGPT", "https://chatgpt.com", "AI", "OpenAI's assistant"),
  A("Claude", "https://claude.ai", "AI", "Anthropic's assistant"),
  A("Duck.ai", "https://duck.ai", "AI", "Private AI chat, no account"),
  A("Google Gemini", "https://gemini.google.com", "AI", "Google's assistant"),
  A("Perplexity", "https://www.perplexity.ai", "AI", "Answer engine with sources"),
  A("GeForce NOW", "https://play.geforcenow.com", "Games", "Cloud gaming"),
  A("Xbox Cloud", "https://www.xbox.com/play", "Games", "Game Pass in the browser"),
  A("now.gg", "https://now.gg", "Games", "Mobile games in the browser"),
  A("Poki", "https://poki.com", "Games", "Thousands of web games"),
  A("CrazyGames", "https://www.crazygames.com", "Games", "Browser games library"),
  A("Chess.com", "https://www.chess.com", "Games", "Play and learn chess"),
  A("Netflix", "https://www.netflix.com", "Video", "Films and series"),
  A("Disney+", "https://www.disneyplus.com", "Video", "Disney, Pixar, Marvel, Star Wars"),
  A("BBC iPlayer", "https://www.bbc.co.uk/iplayer", "Video", "BBC TV on demand"),
  A("Crunchyroll", "https://www.crunchyroll.com", "Video", "Anime streaming"),
  A("GitHub", "https://github.com", "Dev", "Code hosting"),
  A("Stack Overflow", "https://stackoverflow.com", "Dev", "Programming Q&A"),
  A("MDN", "https://developer.mozilla.org", "Dev", "Web docs"),
  A("Photopea", "https://www.photopea.com", "Tools", "Photoshop in the browser"),
  A("Canva", "https://www.canva.com", "Tools", "Design anything"),
  A("Wikipedia", "https://en.wikipedia.org", "Study", "The free encyclopedia"),
  A("Khan Academy", "https://www.khanacademy.org", "Study", "Lessons and practice"),
  A("Duolingo", "https://www.duolingo.com", "Study", "Language lessons"),
  A("Desmos", "https://www.desmos.com/calculator", "Study", "Graphing calculator"),
  A("Quizlet", "https://quizlet.com", "Study", "Flashcards and sets"),
  A("Pinterest", "https://www.pinterest.com", "Social", "Ideas and inspiration"),
  A("Gmail", "https://mail.google.com", "Tools", "Email"),
  A("Google Drive", "https://drive.google.com", "Tools", "Files and docs"),
  A("Amazon", "https://www.amazon.co.uk", "Shop", "Shopping"),
  A("eBay", "https://www.ebay.co.uk", "Shop", "Auctions and deals"),
  A("BBC News", "https://www.bbc.com/news", "News", "World news"),
  A("The Guardian", "https://www.theguardian.com", "News", "UK and world news"),
  A("AP News", "https://apnews.com", "News", "Wire news"),
  A("Google Maps", "https://www.google.com/maps", "Tools", "Maps and directions"),
];

const G = (name, kind, target, cat, desc, emoji) => ({ name, kind, target, cat, desc, emoji });
export const GAMES = [
  // Built into Pine — these always work, even offline.
  G("Pine Snake", "builtin", "/games/snake.html", "Arcade", "The classic, with wrap & speed modes", "🐍"),
  G("2048", "builtin", "/games/2048.html", "Puzzle", "Slide, merge, reach 2048", "🔢"),
  G("Blockfall", "builtin", "/games/blocks.html", "Puzzle", "Falling blocks, hold + ghost piece", "🧱"),
  G("Breakout", "builtin", "/games/breakout.html", "Arcade", "Paddle, ball, bricks, power-ups", "🏓"),
  G("Flappy Pine", "builtin", "/games/flappy.html", "Arcade", "One-button flapping fury", "🐤"),
  G("Memory Grove", "builtin", "/games/memory.html", "Puzzle", "Match the forest pairs", "🍄"),
  G("Mines", "builtin", "/games/mines.html", "Puzzle", "Minesweeper, three difficulties", "💣"),
  G("Coin Clicker", "builtin", "/games/clicker.html", "Idle", "Click for real Pine coins", "🪙"),
  // Around the web — opened through the proxy.
  G("Subway Surfers", "proxy", "https://poki.com/en/g/subway-surfers", "Arcade", "Endless runner on Poki", "🚇"),
  G("Moto X3M", "proxy", "https://poki.com/en/g/moto-x3m", "Racing", "Stunt bike trials", "🏍️"),
  G("Stickman Hook", "proxy", "https://poki.com/en/g/stickman-hook", "Arcade", "Grapple and swing", "🪝"),
  G("Temple Run 2", "proxy", "https://poki.com/en/g/temple-run-2", "Arcade", "Run. Don't look back", "🏃"),
  G("Drive Mad", "proxy", "https://poki.com/en/g/drive-mad", "Racing", "Physics driving chaos", "🚗"),
  G("Vex 7", "proxy", "https://poki.com/en/g/vex-7", "Arcade", "Stick platformer", "🧗"),
  G("Monkey Mart", "proxy", "https://poki.com/en/g/monkey-mart", "Idle", "Run a monkey supermarket", "🐵"),
  G("Shell Shockers", "proxy", "https://shellshock.io", ".io", "Egg FPS", "🥚"),
  G("Krunker", "proxy", "https://krunker.io", ".io", "Fast browser FPS", "🔫"),
  G("1v1.LOL", "proxy", "https://1v1.lol", ".io", "Build fights, 1v1", "🧱"),
  G("Agar.io", "proxy", "https://agar.io", ".io", "Eat or be eaten", "🦠"),
  G("Slither.io", "proxy", "https://slither.io", ".io", "Longest snake wins", "🐛"),
  G("Diep.io", "proxy", "https://diep.io", ".io", "Tank arena", "🎯"),
  G("Slow Roads", "proxy", "https://slowroads.io", "Racing", "Endless relaxing driving", "🛣️"),
  G("Minecraft Classic", "proxy", "https://classic.minecraft.net", "Sandbox", "The original, in-browser", "⛏️"),
  G("GeoGuessr", "proxy", "https://www.geoguessr.com", "Puzzle", "Where in the world?", "🌍"),
  G("Wordle", "proxy", "https://www.nytimes.com/games/wordle/index.html", "Puzzle", "Five letters, six tries", "🟩"),
  G("Little Alchemy 2", "proxy", "https://littlealchemy2.com", "Puzzle", "Combine everything", "⚗️"),
  G("Cookie Clicker", "proxy", "https://orteil.dashnet.org/cookieclicker/", "Idle", "The original idle game", "🍪"),
  G("A Dark Room", "proxy", "https://adarkroom.doublespeakgames.com", "Idle", "Stoke the fire", "🔥"),
  G("Tetris", "proxy", "https://tetris.com/play-tetris", "Puzzle", "Official Tetris", "🕹️"),
  G("2048 (original)", "proxy", "https://play2048.co", "Puzzle", "Gabriele Cirulli's classic", "🔢"),
  G("Cool Math Games", "proxy", "https://www.coolmathgames.com", "Arcade", "The school classic library", "➗"),
  G("CrazyGames", "proxy", "https://www.crazygames.com", "Arcade", "Huge games library", "🎮"),
  G("Poki", "proxy", "https://poki.com", "Arcade", "More games than homework", "🎲"),
];

export const WATCH_SERVICES = [
  A("YouTube", "https://www.youtube.com", "Video", "Everything video"),
  A("Netflix", "https://www.netflix.com", "Video", "Films and series"),
  A("Disney+", "https://www.disneyplus.com", "Video", "Disney, Marvel, Star Wars"),
  A("Prime Video", "https://www.primevideo.com", "Video", "Amazon originals & film"),
  A("BBC iPlayer", "https://www.bbc.co.uk/iplayer", "Video", "BBC programmes"),
  A("ITVX", "https://www.itv.com", "Video", "ITV shows free"),
  A("Channel 4", "https://www.channel4.com", "Video", "C4 streaming"),
  A("Twitch", "https://www.twitch.tv", "Live", "Streams"),
  A("Kick", "https://kick.com", "Live", "Streams"),
  A("TikTok", "https://www.tiktok.com", "Video", "Shorts"),
  A("Crunchyroll", "https://www.crunchyroll.com", "Anime", "Anime"),
  A("Max", "https://www.max.com", "Video", "HBO & Warner"),
  A("Paramount+", "https://www.paramountplus.com", "Video", "Paramount"),
  A("Peacock", "https://www.peacocktv.com", "Video", "NBCUniversal"),
  A("Dailymotion", "https://www.dailymotion.com", "Video", "Video sharing"),
  A("Vimeo", "https://vimeo.com", "Video", "Creator video"),
];

export const LISTEN_SERVICES = [
  A("Spotify", "https://open.spotify.com", "Music", "Streaming"),
  A("YouTube Music", "https://music.youtube.com", "Music", "Streaming"),
  A("SoundCloud", "https://soundcloud.com", "Music", "Tracks & mixes"),
  A("Apple Music", "https://music.apple.com", "Music", "Streaming"),
  A("BBC Sounds", "https://www.bbc.co.uk/sounds", "Radio", "Radio & podcasts"),
  A("Audiomack", "https://audiomack.com", "Music", "Free streaming"),
  A("Bandcamp", "https://bandcamp.com", "Music", "Independent artists"),
  A("Mixcloud", "https://www.mixcloud.com", "Music", "DJ mixes"),
  A("Deezer", "https://www.deezer.com", "Music", "Streaming"),
  A("TIDAL", "https://tidal.com", "Music", "Hi-fi streaming"),
];

// Stations for the built-in generative music player (WebAudio, works offline).
export const STATIONS = [
  { id: "lofi", name: "Lo-fi Grove", desc: "Dusty chords & rain-soft drums", emoji: "🌿", hue: 140 },
  { id: "piano", name: "Midnight Piano", desc: "Slow felt piano, randomly composed", emoji: "🎹", hue: 230 },
  { id: "synth", name: "Neon Pines", desc: "Synthwave arps under the stars", emoji: "🌌", hue: 285 },
  { id: "rain", name: "Forest Rain", desc: "Rain, breeze and distant thunder", emoji: "🌧️", hue: 200 },
  { id: "waves", name: "Night Shore", desc: "Slow ocean swell to focus by", emoji: "🌊", hue: 190 },
  { id: "cafe", name: "Café Static", desc: "Warm vinyl crackle & hum", emoji: "☕", hue: 30 },
];

export const CLOAKS = {
  none: { label: "Pine default (Practice Center)", title: "", icon: "/favicon.svg" },
  docs: { label: "Google Docs", title: "Google Docs", icon: "https://www.google.com/s2/favicons?domain=docs.google.com&sz=64" },
  classroom: { label: "Google Classroom", title: "Home", icon: "https://www.google.com/s2/favicons?domain=classroom.google.com&sz=64" },
  drive: { label: "Google Drive", title: "My Drive - Google Drive", icon: "https://www.google.com/s2/favicons?domain=drive.google.com&sz=64" },
  gmail: { label: "Gmail", title: "Inbox (2) - Gmail", icon: "https://www.google.com/s2/favicons?domain=mail.google.com&sz=64" },
  canvas: { label: "Canvas", title: "Dashboard", icon: "https://www.google.com/s2/favicons?domain=instructure.com&sz=64" },
  khan: { label: "Khan Academy", title: "Khan Academy", icon: "https://www.google.com/s2/favicons?domain=khanacademy.org&sz=64" },
  desmos: { label: "Desmos", title: "Desmos | Graphing Calculator", icon: "https://www.google.com/s2/favicons?domain=desmos.com&sz=64" },
  quizlet: { label: "Quizlet", title: "Quizlet", icon: "https://www.google.com/s2/favicons?domain=quizlet.com&sz=64" },
  wikipedia: { label: "Wikipedia", title: "Wikipedia", icon: "https://www.google.com/s2/favicons?domain=wikipedia.org&sz=64" },
};

export const DEFAULT_TITLE =
  "Student Practice Center | Math, Language Arts, Science, Social Studies, and Spanish";

export const THEMES = {
  pine: { label: "Pine (dark forest)", price: 0 },
  midnight: { label: "Midnight (deep blue)", price: 0 },
  ember: { label: "Ember (warm dark)", price: 750 },
  rose: { label: "Rose (pink dusk)", price: 750 },
  sand: { label: "Sand (light)", price: 500 },
};

export const NAME_COLORS = [
  "#7ee2a8", "#f5c451", "#6cb8ff", "#ff8fa3", "#c4a7fd", "#7ae0e0", "#ffb26b", "#e8e8e8",
  // Pro / shop colours (rainbow handled specially in UI):
  "#ffd700", "#7df9ff", "#ff6bff",
];

export const SHOP = [
  { id: "badge-leaf", kind: "badge", value: "leaf", name: "Leaf badge", desc: "🍃 by your name in chat", price: 100 },
  { id: "badge-star", kind: "badge", value: "star", name: "Star badge", desc: "⭐ by your name in chat", price: 500 },
  { id: "badge-diamond", kind: "badge", value: "diamond", name: "Diamond badge", desc: "💎 the Pro classic", price: 2500 },
  { id: "badge-crown", kind: "badge", value: "crown", name: "Crown badge", desc: "👑 for absolute legends", price: 10000 },
  { id: "theme-ember", kind: "theme", value: "ember", name: "Ember theme", desc: "Warm campfire UI", price: 750 },
  { id: "theme-rose", kind: "theme", value: "rose", name: "Rose theme", desc: "Pink dusk UI", price: 750 },
  { id: "theme-sand", kind: "theme", value: "sand", name: "Sand theme", desc: "Light mode", price: 500 },
  { id: "effect-glow", kind: "effect", value: "glow", name: "Avatar glow", desc: "A soft halo round your avatar", price: 1200 },
  { id: "effect-sparkle", kind: "effect", value: "sparkle", name: "Sparkle ring", desc: "Twinkling profile ring", price: 3000 },
];

export const PRO_PRICE = 5000;

export const STUDY_TOPICS = [
  { subject: "Mathematics", emoji: "➗", blurb: "Fractions to calculus, mapped to Common Core.", q: "fractions explained for kids" },
  { subject: "English Language Arts", emoji: "📚", blurb: "Close reading, grammar and essay writing.", q: "how to write a thesis statement" },
  { subject: "Science", emoji: "🔬", blurb: "Cells, atoms, forces and the solar system.", q: "photosynthesis explained" },
  { subject: "Social Studies", emoji: "🏛️", blurb: "Civics, world history and geography.", q: "three branches of government explained" },
  { subject: "World Languages", emoji: "🌎", blurb: "Spanish, French, German and more, A1–C1.", q: "spanish greetings and phrases" },
  { subject: "Test Preparation", emoji: "📝", blurb: "SAT, ACT and AP practice with worked answers.", q: "SAT math practice questions" },
];
