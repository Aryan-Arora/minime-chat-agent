import type { MemoryNote, Message, NoteVolatility } from "../types.js";

export const NOTE_EXTRACTION_SYSTEM = `Extract one compact memory note from a completed chat exchange.
Return JSON only with: topic, claim, sources, query, volatility.
topic: a short noun phrase. claim: the useful fact or conclusion, including key values.
sources: source URLs actually present in the answer. query: the web query if stated, otherwise omit it.
volatility: "volatile" for facts likely to change (prices, availability, people, versions, news); otherwise "stable".
Do not invent facts, URLs, or a query. If there is no reusable fact, use an empty claim.`;

/** Pure prompt builder; Claude can pass this request to the fast model in the background. */
export function buildNoteExtractionPrompt(user: Message, assistant: Message): string {
  return [
    `Exchange date: ${assistant.createdAt.slice(0, 10)}`,
    `Conversation: ${assistant.conversationId}`,
    `User: ${user.content}`,
    `Assistant: ${assistant.content}`,
  ].join("\n");
}

type NoteMeta = Pick<MemoryNote, "id" | "conversationId" | "createdAt">;

/** Validate model output before it crosses the storage boundary. */
export function parseNoteExtraction(raw: string, meta: NoteMeta): MemoryNote | null {
  let value: unknown;
  try {
    // Some models still wrap requested JSON in a fence; accept that harmless wrapper.
    const json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    value = JSON.parse(json);
  } catch {
    return null;
  }
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

function clean(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}
