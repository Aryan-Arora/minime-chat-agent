import type { MemoryNote, Message, NoteVolatility, SearchResult, SnapshotValue } from "../types.js";

export const NOTE_EXTRACTION_SYSTEM = `Extract one compact memory note from a completed chat exchange.
Return JSON only with: topic, claim, sources, query, volatility, snapshot.
topic: a short noun phrase (max 12 words). claim: the useful fact or conclusion, including key values (max 60 words).
sources: source URLs actually present in the answer. query: the web query if stated, otherwise omit it.
volatility: "volatile" for facts likely to change (prices, availability, people, versions, news); otherwise "stable".
snapshot: for volatile claims, an object of short snake_case keys to scalar values. Use {} for stable claims.
Do not invent facts, URLs, or a query. If there is no reusable fact, use an empty claim.`;

export const SNAPSHOT_EXTRACTION_SYSTEM = `Extract current key values from fresh web evidence for comparison with an older claim.
Return one small JSON object only. Use the supplied old snapshot's exact keys when the evidence supports them.
Values must be strings, numbers, booleans, or null. Omit values not supported by the evidence. Never guess.`;

/** Pure prompt builder; Claude can pass this request to the fast model in the background. */
export function buildNoteExtractionPrompt(
  user: Message,
  assistant: Message,
  evidence?: { query?: string; sources?: string[] },
): string {
  return [
    `Exchange date: ${assistant.createdAt.slice(0, 10)}`,
    `Conversation: ${assistant.conversationId}`,
    `User: ${user.content}`,
    `Assistant: ${assistant.content}`,
    evidence?.query ? `Search query: ${evidence.query}` : "",
    evidence?.sources?.length ? `Source URLs: ${evidence.sources.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

type NoteMeta = Pick<MemoryNote, "id" | "conversationId" | "createdAt">;

/** Validate model output before it crosses the storage boundary. */
export function parseNoteExtraction(raw: string, meta: NoteMeta): MemoryNote | null {
  const value = parseJson(raw);
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const topic = clean(item.topic, 120);
  const claim = clean(item.claim, 800);
  if (!topic || !claim) return null; // empty claims are intentionally not remembered

  const volatility: NoteVolatility = item.volatility === "volatile" ? "volatile" : "stable";
  const sources = Array.isArray(item.sources)
    ? [...new Set(item.sources.filter((source): source is string => typeof source === "string" && /^https?:\/\//.test(source)))].slice(0, 8)
    : [];
  const query = clean(item.query, 240);
  return { ...meta, topic, claim, sources, ...(query ? { query } : {}), volatility };
}

export function parseSnapshot(raw: string): Record<string, SnapshotValue> {
  const value = parseJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, SnapshotValue> = {};
  for (const [rawKey, item] of Object.entries(value).slice(0, 20)) {
    const key = rawKey.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
    if (key && (item === null || ["string", "number", "boolean"].includes(typeof item))) {
      out[key] = typeof item === "string" ? item.slice(0, 200) : item as number | boolean | null;
    }
  }
  return out;
}

export function snapshotFromNoteExtraction(raw: string): Record<string, SnapshotValue> {
  const value = parseJson(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return parseSnapshot(JSON.stringify((value as Record<string, unknown>).snapshot ?? {}));
}

export function buildSnapshotExtractionPrompt(
  oldClaim: string,
  oldSnapshot: Record<string, SnapshotValue>,
  results: SearchResult[],
): string {
  return [
    `Old claim: ${oldClaim}`,
    `Old snapshot: ${JSON.stringify(oldSnapshot)}`,
    "Fresh evidence:",
    ...results.map((result, index) => `[${index + 1}] ${result.title}\n${result.content ?? result.snippet}`),
  ].join("\n\n");
}

function parseJson(raw: string): unknown {
  try {
    // Some models still wrap requested JSON in a fence; accept that harmless wrapper.
    const json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function clean(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}
