/* Pine — the study assistant ("AI" tab).
 *
 * Works out of the box with no API key: maths is solved locally by a real
 * expression parser, unit conversions are local too, and general questions
 * go to DuckDuckGo Instant Answers via /api/answer. Power users can add an
 * OpenAI-compatible API key in Settings — it stays in the browser and is
 * sent straight from here to that API, never to the Pine server. */

/* ---------------- maths ---------------- */

const FUNCS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, sin: Math.sin, cos: Math.cos,
  tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  log: Math.log10, ln: Math.log, exp: Math.exp, floor: Math.floor, ceil: Math.ceil,
  round: Math.round,
};
const CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: 1.618033988749895 };

function tokenise(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (c === " " || c === ",") { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i, dots = 0;
      while (j < str.length && /[0-9.]/.test(str[j])) { if (str[j] === ".") dots++; j++; }
      if (dots > 1) return null;
      tokens.push({ t: "num", v: parseFloat(str.slice(i, j)) });
      i = j; continue;
    }
    if (/[a-z]/i.test(c)) {
      let j = i;
      while (j < str.length && /[a-z]/i.test(str[j])) j++;
      tokens.push({ t: "id", v: str.slice(i, j).toLowerCase() });
      i = j; continue;
    }
    if ("+-*/%^()!".includes(c)) { tokens.push({ t: c }); i++; continue; }
    return null;
  }
  return tokens;
}

const factorial = (n) => {
  if (n < 0 || !Number.isInteger(n) || n > 170) return NaN;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
};

export function evaluateMath(raw) {
  let expr = String(raw)
    .replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/\^/g, "^")
    .replace(/\bx\b/gi, "*")
    .replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*/gi, "($1/100)*")
    .replace(/\bsquare root of\b/gi, "sqrt ")
    .trim();

  // Percent postfix: "50%" → (50/100), but keep % as modulo between numbers.
  expr = expr.replace(/(\d+(?:\.\d+)?)%(?!\s*\d)/g, "($1/100)");

  const tokens = tokenise(expr);
  if (!tokens || !tokens.length) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t) => { if (peek()?.t === t) { pos++; return true; } return false; };

  function parseExpr() {
    let v = parseTerm();
    while (peek()?.t === "+" || peek()?.t === "-") {
      const op = tokens[pos++].t;
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (true) {
      if (eat("*")) v *= parseFactor();
      else if (eat("/")) v /= parseFactor();
      else if (eat("%")) v %= parseFactor();
      else if (peek()?.t === "(" || peek()?.t === "id" || peek()?.t === "num") v *= parseFactor(); // implicit ×
      else break;
    }
    return v;
  }
  function parseFactor() {
    const base = parseUnary();
    if (eat("^")) return Math.pow(base, parseFactor());
    return base;
  }
  function parseUnary() {
    if (eat("-")) return -parseUnary();
    if (eat("+")) return parseUnary();
    let v = parseAtom();
    while (eat("!")) v = factorial(v);
    return v;
  }
  function parseAtom() {
    const tk = tokens[pos++];
    if (!tk) throw new Error("unexpected end");
    if (tk.t === "num") return tk.v;
    if (tk.t === "(") { const v = parseExpr(); if (!eat(")")) throw new Error("missing )"); return v; }
    if (tk.t === "id") {
      if (tk.v in CONSTS) return CONSTS[tk.v];
      if (tk.v in FUNCS) {
        const arg = peek()?.t === "(" ? parseAtom() : parseUnary();
        return FUNCS[tk.v](arg);
      }
      throw new Error(`unknown: ${tk.v}`);
    }
    throw new Error(`unexpected ${tk.t}`);
  }

  try {
    const value = parseExpr();
    if (pos !== tokens.length) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return value;
  } catch {
    return null;
  }
}

export function formatNumber(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toLocaleString("en-GB");
  if (Math.abs(n) >= 1e15 || (Math.abs(n) < 1e-9 && n !== 0)) return n.toExponential(6);
  return String(Math.round(n * 1e10) / 1e10);
}

/* ---------------- unit conversions ---------------- */

const UNITS = {
  // to a base unit
  mm: ["length", 0.001], cm: ["length", 0.01], m: ["length", 1], km: ["length", 1000],
  in: ["length", 0.0254], inch: ["length", 0.0254], inches: ["length", 0.0254],
  ft: ["length", 0.3048], feet: ["length", 0.3048], foot: ["length", 0.3048],
  yd: ["length", 0.9144], mi: ["length", 1609.344], mile: ["length", 1609.344], miles: ["length", 1609.344],
  g: ["mass", 1], kg: ["mass", 1000], lb: ["mass", 453.59237], lbs: ["mass", 453.59237],
  oz: ["mass", 28.349523125], tonne: ["mass", 1e6], tonnes: ["mass", 1e6],
  ml: ["volume", 1], l: ["volume", 1000], litre: ["volume", 1000], litres: ["volume", 1000],
  gal: ["volume", 4546.09], gallon: ["volume", 4546.09], gallons: ["volume", 4546.09],
  s: ["time", 1], sec: ["time", 1], seconds: ["time", 1], min: ["time", 60], minutes: ["time", 60],
  h: ["time", 3600], hr: ["time", 3600], hours: ["time", 3600], day: ["time", 86400], days: ["time", 86400],
  kb: ["data", 1e3], mb: ["data", 1e6], gb: ["data", 1e9], tb: ["data", 1e12],
  mph: ["speed", 1], kmh: ["speed", 0.621371192], "km/h": ["speed", 0.621371192],
};

export function convertUnits(raw) {
  const m = String(raw).toLowerCase().match(/(-?\d+(?:\.\d+)?)\s*([a-z/]+)\s+(?:to|in)\s+([a-z/]+)/);
  if (!m) return null;
  const [, numStr, fromRaw, toRaw] = m;
  const value = parseFloat(numStr);

  const temp = { c: "c", celsius: "c", "°c": "c", f: "f", fahrenheit: "f", "°f": "f", k: "k", kelvin: "k" };
  if (temp[fromRaw] && temp[toRaw]) {
    let c;
    if (temp[fromRaw] === "c") c = value;
    else if (temp[fromRaw] === "f") c = (value - 32) * 5 / 9;
    else c = value - 273.15;
    let out, label;
    if (temp[toRaw] === "c") { out = c; label = "°C"; }
    else if (temp[toRaw] === "f") { out = c * 9 / 5 + 32; label = "°F"; }
    else { out = c + 273.15; label = "K"; }
    return { text: `${numStr}${temp[fromRaw] === "k" ? " K" : "°" + temp[fromRaw].toUpperCase()} = **${formatNumber(Math.round(out * 100) / 100)}${label}**` };
  }

  const from = UNITS[fromRaw], to = UNITS[toRaw];
  if (!from || !to || from[0] !== to[0]) return null;
  const result = value * from[1] / to[1];
  return { text: `${numStr} ${fromRaw} = **${formatNumber(Math.round(result * 1e6) / 1e6)} ${toRaw}**` };
}

/* ---------------- the assistant ---------------- */

const history = [];

function looksMathy(q) {
  const s = q.toLowerCase().replace(/^(what is|what's|calculate|compute|evaluate|solve|work out)\s+/, "").replace(/\?$/, "");
  if (/^[-+(\d]/.test(s)) return s;
  if (/^sqrt|^sin|^cos|^tan|^log|^ln/.test(s)) return s;
  if (/\d\s*%\s*of\s*\d/.test(s)) return s;
  return null;
}

export async function askAI(rawQuestion, settings) {
  const q = String(rawQuestion || "").trim();
  if (!q) return { text: "Ask me a question — maths, conversions, definitions, facts…" };

  // 1) Your own model, if configured.
  if (settings?.aiKey) {
    try {
      const base = (settings.aiBase || "https://api.openai.com").replace(/\/$/, "");
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${settings.aiKey}` },
        body: JSON.stringify({
          model: settings.aiModel || "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are a friendly, concise study assistant inside an app called Pine. British English. Prefer short answers with the working shown for maths." },
            ...history.slice(-6),
            { role: "user", content: q },
          ],
          temperature: 0.4,
        }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text) {
        history.push({ role: "user", content: q }, { role: "assistant", content: text });
        return { text, via: "api" };
      }
    } catch (err) {
      history.push({ role: "user", content: q });
      return { text: `Your API call failed (${err.message}). Check Settings → AI — in the meantime, here's what I can do locally:\n\n${(await localAnswer(q)).text}`, via: "local" };
    }
  }
  return localAnswer(q);
}

async function localAnswer(q) {
  const lower = q.toLowerCase().replace(/\?+$/, "").trim();

  if (/^(hi|hello|hey|yo|sup|hiya)\b/.test(lower))
    return { text: "Hey 🌲 I'm Pine's built-in study buddy. I can do maths (try `17 × 24`, `15% of 230`, `sqrt(144) + 3^4`), unit conversions (`5 km to miles`, `72f to c`), and look up facts and definitions. What are we working on?", via: "local" };
  if (/\b(your name|who are you)\b/.test(lower))
    return { text: "I'm the Pine study assistant — a small local brain (maths + conversions + web lookups) right in this tab. For a full AI model, add an API key in Settings → AI, or open ChatGPT/Claude from the Apps tab.", via: "local" };
  if (/^(help|what can you do)/.test(lower))
    return { text: "I can:\n• **Maths** — `48 / 6 × 3`, `2^10`, `15% of 80`, `sin(0.5)`, `7!`\n• **Conversions** — `10 kg to lbs`, `3 hours to minutes`, `100c to f`\n• **Facts & definitions** — ask me what something is, and I'll look it up and cite it.\n• With an API key (Settings → AI), I become a full chat model.", via: "local" };

  // Maths?
  const conv = convertUnits(q);
  if (conv) return { ...conv, via: "local" };
  const mathy = looksMathy(q);
  if (mathy) {
    const value = evaluateMath(mathy);
    if (value !== null) return { text: `${mathy} = **${formatNumber(value)}**`, via: "local" };
  }

  // The date/time costs nothing:
  if (/\b(what|current)\b.*\b(date|day|time)\b/.test(lower)) {
    const now = new Date();
    return { text: `It's **${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}**, ${now.toLocaleTimeString("en-GB")} where you are.`, via: "local" };
  }

  // Web lookup.
  try {
    const res = await fetch(`/api/answer?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const parts = [];
    if (data.answer) parts.push(`**${data.answer}**`);
    if (data.definition) parts.push(data.definition);
    if (data.abstract) parts.push(data.abstract);
    const actions = [];
    if (data.abstractUrl) actions.push({ label: data.heading ? `Read: ${data.heading}` : "Source", url: data.abstractUrl });
    for (const r of (data.related || []).slice(0, 3)) actions.push({ label: r.text.split(" - ")[0].slice(0, 60), url: r.url });
    actions.push({ label: `Search “${q.slice(0, 40)}”`, search: q });
    if (parts.length) return { text: parts.join("\n\n"), actions, via: "web" };
    return {
      text: `I couldn't find a one-line answer for that locally. Try a full search — or ask a bigger brain (ChatGPT, Claude and Duck.ai are in the Apps tab and open through the proxy).`,
      actions,
      via: "web",
    };
  } catch {
    return { text: "I couldn't reach the lookup service just now. Maths and conversions still work — or search from the Home tab.", via: "local" };

  }
}

export function resetAI() {
  history.length = 0;
}
