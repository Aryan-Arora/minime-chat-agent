// web_search wrapper. The agent only sees the SearchTool interface, so the provider
// can be swapped without touching the loop. Default: Tavily (returns page text,
// which we need to re-check old answers). Not final: see open decisions in CLAUDE.md.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SearchResult, SearchTool } from "../types.js";

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  raw_content?: string | null;
  published_date?: string;
}

function cacheDb(file: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS search_cache (
    cache_key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, results TEXT NOT NULL
  )`);
  return db;
}

export function createTavilySearch(
  apiKey = process.env.SEARCH_API_KEY,
  cacheFile = path.resolve("data/search-cache.sqlite"),
): SearchTool {
  if (!apiKey) throw new Error("SEARCH_API_KEY is not set (see .env.example)");

  // Tiny in-memory cache: the same query inside a session should not pay twice.
  const cache = new Map<string, { at: number; results: SearchResult[] }>();
  const TTL_MS = 10 * 60 * 1000;

  return {
    async search(query, opts = {}) {
      const key = JSON.stringify([query, opts]);
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.results;
      // The SQLite cache survives restarts and is internal context, not another agent tool.
      const db = cacheDb(cacheFile);
      try {
        const saved = db.prepare(`SELECT results FROM search_cache WHERE cache_key = ? AND expires_at > ?`)
          .get(key, Date.now()) as { results: string } | undefined;
        if (saved) {
          const results = JSON.parse(saved.results) as SearchResult[];
          cache.set(key, { at: Date.now(), results });
          return results;
        }
      } finally { db.close(); }

      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query,
          // Ask for extras so deduplication can still return a diverse final set.
          max_results: Math.min((opts.maxResults ?? 5) * 2, 10),
          include_raw_content: false,
          // sinceDays lets the agent ask "what changed lately" instead of all-time results.
          ...(opts.sinceDays ? { days: opts.sinceDays, topic: "news" } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);

      const data = (await res.json()) as { results: TavilyResult[] };
      const seen = new Set<string>();
      const domains = new Map<string, number>();
      const results: SearchResult[] = [];
      for (const r of data.results) {
        let normalized: string;
        let domain: string;
        try {
          const url = new URL(r.url);
          url.hash = ""; url.search = "";
          normalized = url.toString().replace(/\/$/, "");
          domain = url.hostname.replace(/^www\./, "");
        } catch { continue; }
        // At most two pages per domain keeps one publisher from crowding out corroboration.
        if (seen.has(normalized) || (domains.get(domain) ?? 0) >= 2) continue;
        seen.add(normalized); domains.set(domain, (domains.get(domain) ?? 0) + 1);
        results.push({
          title: r.title, url: r.url, snippet: r.content.slice(0, 300), content: r.content,
          ...(r.published_date ? { publishedAt: r.published_date } : {}),
        });
        if (results.length >= (opts.maxResults ?? 5)) break;
      }
      cache.set(key, { at: Date.now(), results });
      const write = cacheDb(cacheFile);
      try {
        write.prepare(`INSERT INTO search_cache(cache_key, expires_at, results) VALUES (?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET expires_at=excluded.expires_at, results=excluded.results`)
          .run(key, Date.now() + TTL_MS, JSON.stringify(results));
        write.prepare(`DELETE FROM search_cache WHERE expires_at <= ?`).run(Date.now());
      } finally { write.close(); }
      return results;
    },
  };
}
