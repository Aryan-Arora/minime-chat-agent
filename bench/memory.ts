// Deterministic retrieval benchmark: measures whether FTS finds the expected note and
// how much prompt text compact notes save versus the source exchanges.
import { createSqliteMemory } from "../src/memory/sqlite.js";
import type { MemoryNote, Message } from "../src/types.js";

const memory = createSqliteMemory(":memory:");
const notes: MemoryNote[] = [
  { id: "postgres", conversationId: "a", createdAt: "2026-11-03T09:01:00Z", topic: "Postgres hosting shortlist", claim: "Neon was cheapest at $19 monthly; Supabase was preferred for auth.", sources: [], query: "Neon Supabase pricing", volatility: "volatile" },
  { id: "crm", conversationId: "b", createdAt: "2026-11-03T11:01:00Z", topic: "CRM shortlist", claim: "The shortlist was Attio, HubSpot and Pipedrive; Attio was preferred.", sources: [], volatility: "stable" },
  { id: "capital", conversationId: "c", createdAt: "2026-11-04T10:01:00Z", topic: "Capital of France", claim: "Paris is the capital of France.", sources: [], volatility: "stable" },
];
const transcripts: Message[] = notes.flatMap((note) => [
  { id: `${note.id}-u`, role: "user", content: `Please research ${note.topic} and compare all relevant details in depth. `.repeat(8), createdAt: note.createdAt, conversationId: note.conversationId },
  { id: `${note.id}-a`, role: "assistant", content: `${note.claim} Supporting explanation and caveats. `.repeat(10), createdAt: note.createdAt, conversationId: note.conversationId },
]);
for (const note of notes) await memory.saveNote(note);
for (const message of transcripts) await memory.save(message);

const cases = [
  { query: "What did we decide about Postgres hosting?", expected: "postgres" },
  { query: "Which CRM did we prefer?", expected: "crm" },
  { query: "What is the capital of France?", expected: "capital" },
];
let correct = 0;
for (const item of cases) {
  const result = await memory.retrieve(item.query, undefined, 3);
  if (result[0]?.id === item.expected) correct += 1;
}
const rawChars = transcripts.reduce((sum, item) => sum + item.content.length, 0);
const noteChars = notes.reduce((sum, item) => sum + item.topic.length + item.claim.length, 0);
console.table([{
  cases: cases.length,
  topResultAccuracy: `${Math.round(correct / cases.length * 100)}%`,
  transcriptChars: rawChars,
  noteChars,
  contextReduction: `${Math.round((1 - noteChars / rawChars) * 100)}%`,
}]);
memory.close();
