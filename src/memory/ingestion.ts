import { createHash } from "node:crypto";
import type { MemoryCandidate, MemoryCategory, MemoryIngestionSource, MemoryNote } from "../types.js";

export interface RelevanceDecision {
  outcome: "accept" | "reject";
  category: MemoryCategory;
  confidence: number;
  reason: string;
}

/** Cheap rules keep greetings and empty exchanges out before any extraction call. */
export function assessRelevance(source: MemoryIngestionSource): RelevanceDecision {
  const user = source.user.content.trim();
  const answer = source.assistant.content.trim();
  if (!answer || user.length < 3) return reject("empty exchange");
  if (/^(hi|hello|hey|thanks|thank you|ok(?:ay)?|cool|great)[!.\s]*$/i.test(user)) return reject("social acknowledgement");
  if (/\b(cannot (?:access|see|recall)|can't (?:access|see|recall)|could not (?:access|find|recall|verify)|no (?:earlier |prior )?(?:chat|conversation|history)|search (?:failed|returned no))\b/i.test(answer)) {
    return reject("assistant limitation or failed retrieval");
  }
  if (/\b(i prefer|my preference|i like|i want (?:answers|responses)|always show)\b/i.test(user)) {
    return accept("preference", .98, "explicit user preference");
  }
  if (/\b(we decided|i decided|we chose|i chose|selected|settled on)\b/i.test(user)) {
    return accept("decision", .94, "explicit decision");
  }
  if (/\b(i plan|we plan|next step|will build|going to)\b/i.test(user)) {
    return accept("plan", .9, "reusable plan");
  }
  if (source.sources.length || source.query) return accept("research_finding", .88, "source-backed research");
  if (answer.length >= 80) return accept("research_finding", .72, "substantive completed exchange");
  return reject("too little reusable information");
}

/** Converts today's note format into the first structured candidate format. */
export function candidateFromNote(
  source: MemoryIngestionSource,
  note: MemoryNote,
  relevance: RelevanceDecision,
): MemoryCandidate {
  const predicate = {
    preference: "prefers",
    decision: "decided",
    plan: "plans",
    personal_fact: "is",
    research_finding: "states",
  }[relevance.category];
  return {
    id: cryptoId(source.id, note.id), sourceId: source.id, noteId: note.id,
    conversationId: source.conversationId, subject: note.topic, predicate, object: note.claim,
    category: relevance.category, confidence: relevance.confidence, volatility: note.volatility,
    evidence: [source.user.id, source.assistant.id, ...note.sources],
    fingerprint: memoryFingerprint(note.topic, predicate, note.claim), createdAt: note.createdAt,
  };
}

export function memoryFingerprint(subject: string, predicate: string, object: string): string {
  const normalized = [subject, predicate, object]
    .map((value) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim())
    .join("|");
  return createHash("sha256").update(normalized).digest("hex");
}

/** Conservative token overlap: useful for duplicate candidates, never proof of equivalence. */
export function tokenSimilarity(left: string, right: string): number {
  const tokens = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const a = tokens(left), b = tokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / new Set([...a, ...b]).size;
}

function cryptoId(sourceId: string, noteId: string): string {
  return createHash("sha256").update(`${sourceId}:${noteId}`).digest("hex").slice(0, 32);
}

function accept(category: MemoryCategory, confidence: number, reason: string): RelevanceDecision {
  return { outcome: "accept", category, confidence, reason };
}
function reject(reason: string): RelevanceDecision {
  return { outcome: "reject", category: "research_finding", confidence: 1, reason };
}
