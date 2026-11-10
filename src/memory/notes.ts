import type { Message } from "../types.js";

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
