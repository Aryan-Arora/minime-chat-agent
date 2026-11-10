// web_search wrapper. The agent only sees the SearchTool interface, so the provider
// can be swapped without touching the loop. Default: Tavily (returns page text,
// which we need to re-check old answers). Not final: see open decisions in CLAUDE.md.
import type { SearchResult, SearchTool } from "../types.js";

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  raw_content?: string | null;
  published_date?: string;
}

export function createTavilySearch(apiKey = process.env.SEARCH_API_KEY): SearchTool {
  if (!apiKey) throw new Error("SEARCH_API_KEY is not set (see .env.example)");

  // Tiny in-memory cache: the same query inside a session should not pay twice.
  const cache = new Map<string, { at: number; results: SearchResult[] }>();
  const TTL_MS = 10 * 60 * 1000;

  return {
    async search(query, opts = {}) {
      const key = JSON.stringify([query, opts]);
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.results;

      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query,
          max_results: opts.maxResults ?? 5,
          include_raw_content: false,
          // sinceDays lets the agent ask "what changed lately" instead of all-time results.
          ...(opts.sinceDays ? { days: opts.sinceDays, topic: "news" } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);

      const data = (await res.json()) as { results: TavilyResult[] };
      const results: SearchResult[] = data.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content.slice(0, 300),
        content: r.content,
        publishedAt: r.published_date,
      }));
      cache.set(key, { at: Date.now(), results });
      return results;
    },
  };
}
