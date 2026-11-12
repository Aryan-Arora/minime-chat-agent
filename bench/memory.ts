// Deterministic retrieval benchmark with exact, lexical, semantic and negative cases.
import { memoryFingerprint } from "../src/memory/ingestion.js";
import { createSqliteMemory } from "../src/memory/sqlite.js";
import type { MemoryCandidate, MemoryNote, Message } from "../src/types.js";

try { process.loadEnvFile(".env"); } catch { /* Deterministic FTS benchmark still runs without keys. */ }

const memory = createSqliteMemory(":memory:");
const notes: MemoryNote[] = [
  { id: "postgres", conversationId: "a", createdAt: "2026-11-03T09:01:00Z", topic: "Postgres hosting shortlist", claim: "Neon was cheapest at $19 monthly; Supabase was preferred for authentication.", sources: [], volatility: "volatile" },
  { id: "crm", conversationId: "b", createdAt: "2026-11-03T11:01:00Z", topic: "CRM shortlist", claim: "The shortlist was Attio, HubSpot and Pipedrive; Attio was preferred.", sources: [], volatility: "stable" },
  { id: "style", conversationId: "c", createdAt: "2026-11-04T10:01:00Z", topic: "Response style preference", claim: "Aryan prefers concise answers that lead with a recommendation and show sources.", sources: [], volatility: "stable" },
  { id: "storage", conversationId: "d", createdAt: "2026-11-05T10:01:00Z", topic: "Memory storage decision", claim: "SQLite was selected for MiniMe because it is local, fast and easy to explain.", sources: [], volatility: "stable" },
  { id: "weather", conversationId: "e", createdAt: "2026-11-06T10:01:00Z", topic: "Indonesia weather outlook", claim: "Jakarta and Bali were hot, humid and likely to have tropical showers.", sources: [], volatility: "volatile" },
  { id: "index", conversationId: "f", createdAt: "2026-11-07T10:01:00Z", topic: "Database index trade-offs", claim: "A B-tree index avoids full table scans but makes database writes slower.", sources: [], volatility: "stable" },
];
const transcripts: Message[] = notes.flatMap((note) => [
  { id: `${note.id}-u`, role: "user", content: `Please research ${note.topic} and compare all relevant details in depth. `.repeat(8), createdAt: note.createdAt, conversationId: note.conversationId },
  { id: `${note.id}-a`, role: "assistant", content: `${note.claim} Supporting explanation and caveats. `.repeat(10), createdAt: note.createdAt, conversationId: note.conversationId },
]);
for (const note of notes) await memory.saveNote(note);
for (const message of transcripts) await memory.save(message);

// Structured categories provide a cheap fallback when semantic wording has no FTS overlap.
for (const [noteId, category, predicate] of [["crm", "decision", "decided"], ["style", "preference", "prefers"], ["storage", "decision", "decided"]] as const) {
  const note = notes.find((item) => item.id === noteId)!;
  const candidate: MemoryCandidate = {
    id: `candidate-${note.id}`, sourceId: `source-${note.id}`, noteId: note.id,
    conversationId: note.conversationId, subject: note.topic, predicate, object: note.claim,
    category, confidence: .95, volatility: note.volatility, evidence: [],
    fingerprint: memoryFingerprint(note.topic, predicate, note.claim), createdAt: note.createdAt,
  };
  await memory.resolveCandidate(candidate);
}

const cases = [
  ["exact", "Postgres hosting shortlist", "postgres"],
  ["exact", "Which CRM did we prefer?", "crm"],
  ["exact", "Indonesia weather outlook", "weather"],
  ["exact", "database index trade-offs", "index"],
  ["exact", "response style preference", "style"],
  ["exact", "SQLite memory decision", "storage"],
  ["lexical", "Postgres provider authentication", "postgres"],
  ["lexical", "customer relationship shortlist Attio", "crm"],
  ["lexical", "concise replies with sources", "style"],
  ["lexical", "local database selected for memory", "storage"],
  ["lexical", "weather for Indonesian cities", "weather"],
  ["lexical", "B-tree database writes", "index"],
  ["semantic", "Which backend data service won?", "postgres"],
  ["semantic", "What sales software did we settle on?", "crm"],
  ["semantic", "How should you format responses for me?", "style"],
  ["semantic", "What persistence layer did we choose?", "storage"],
  ["semantic", "Will I need an umbrella in Jakarta?", "weather"],
  ["semantic", "How can queries avoid scanning every row?", "index"],
] as const;

const rows = [];
for (const [tier, query, expected] of cases) {
  const result = await memory.retrieve(query, undefined, 3);
  rows.push({ tier, query, expected, top: result[0]?.id ?? "MISS", top3: result.some((item) => item.id === expected) });
}
const negatives = ["What is my favorite movie?", "When is my medical appointment?", "Which password manager do I use?"];
const falsePositives = (await Promise.all(negatives.map((query) => memory.retrieve(query, undefined, 3))))
  .filter((result) => result.length > 0).length;
const rawChars = transcripts.reduce((sum, item) => sum + item.content.length, 0);
const noteChars = notes.reduce((sum, item) => sum + item.topic.length + item.claim.length, 0);

console.table(rows);
for (const tier of ["exact", "lexical", "semantic"]) {
  const group = rows.filter((row) => row.tier === tier);
  const top1 = group.filter((row) => row.top === row.expected).length;
  const top3 = group.filter((row) => row.top3).length;
  console.log(`${tier}: top-1 ${top1}/${group.length} (${Math.round(top1 / group.length * 100)}%), top-3 ${top3}/${group.length} (${Math.round(top3 / group.length * 100)}%)`);
}
console.log(`negative false positives: ${falsePositives}/${negatives.length}`);
console.log(`context reduction: ${Math.round((1 - noteChars / rawChars) * 100)}%`);
memory.close();
