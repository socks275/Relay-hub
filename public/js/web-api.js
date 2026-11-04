/* Pine — the small suggestion and instant-answer lookups.
 *
 * Server edition: call Pine's cached/rate-limited /api endpoints.
 * GitHub Pages edition: call the same DuckDuckGo endpoints directly from
 * the browser. These helpers are deliberately isolated and accept a
 * staticMode override so both response mappings can be unit-tested.
 */
import { appUrl, STATIC_MODE } from "./proxy.js";

export function mapSuggestions(data) {
  const source = Array.isArray(data) ? data : data?.suggestions;
  if (!Array.isArray(source)) return [];
  return source
    .map((d) => (typeof d === "string" ? d : d?.phrase))
    .filter((s) => typeof s === "string" && s.trim())
    .slice(0, 8);
}

export async function fetchSuggestions(q, { signal, staticMode = STATIC_MODE } = {}) {
  const query = String(q || "").slice(0, 120);
  if (!query) return [];
  const url = staticMode
    ? `https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}&type=json`
    : `${appUrl("api/suggest")}?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Suggestion lookup failed (${res.status})`);
  return mapSuggestions(await res.json());
}

export function normaliseInstantAnswer(data = {}) {
  if (!data || typeof data !== "object") return { answer: null };
  // Server responses are already in Pine's normalised shape.
  if ("abstract" in data || "definition" in data || "heading" in data) return data;
  return {
    heading: data.Heading || null,
    abstract: data.AbstractText || null,
    abstractUrl: data.AbstractURL || null,
    answer: data.Answer || null,
    definition: data.Definition || null,
    related: (Array.isArray(data.RelatedTopics) ? data.RelatedTopics : [])
      .filter((t) => t && t.Text && t.FirstURL)
      .slice(0, 5)
      .map((t) => ({ text: t.Text, url: t.FirstURL })),
  };
}

export async function fetchInstantAnswer(q, { staticMode = STATIC_MODE } = {}) {
  const query = String(q || "").slice(0, 200);
  if (!query) return { answer: null };
  const url = staticMode
    ? `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&no_redirect=1`
    : `${appUrl("api/answer")}?q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Instant-answer lookup failed (${res.status})`);
  return normaliseInstantAnswer(await res.json());
}
