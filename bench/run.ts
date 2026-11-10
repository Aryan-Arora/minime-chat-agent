// Benchmark runner. Same questions, same prompts, one model at a time; records time to
// first token, total time, searches and a placeholder cost. Runs on stubs without keys
// (proves the harness works); real models plug in via the adapters in src/models/.
import { runAgent, type AgentDeps, type AgentEvent } from "../src/agent/loop.js";
import type { MemoryStore, Message } from "../src/types.js";
import { createStubModel, createStubSearch } from "../src/models/stub.js";
import { costUsd } from "../src/models/pricing.js";

const QUESTIONS = [
  "What did I ask you on 3 November?",
  "I shortlisted 5 CRM tools last Monday: has any changed pricing since?",
  "I asked about Postgres hosting last Tuesday: has any pricing changed since then?",
  "What is the capital of France?",
  "What is the latest news today in AI?",
  "Compare pricing of Notion, Coda, Airtable, ClickUp and Monday.",
  "Two sources disagree on a product's price. What is it?",
  "Tell me about the best one.",
  "What about the second one?",
  "How do I enable the Quantum Mode feature in Postgres 17?",
];

// In-memory store so benchmark runs never touch real chat history.
function memoryStub(seed: Message[]): MemoryStore {
  const all = [...seed];
  return {
    async save(m) { all.push(m); },
    async between(a, b) { return all.filter((m) => m.createdAt >= a && m.createdAt < b); },
    async recent(n) { return all.slice(-n); },
  };
}

const PINNED_NOW = new Date("2026-11-10T12:00:00Z"); // fixed "today" so date phrases are reproducible

async function runOne(deps: AgentDeps, q: string) {
  const t0 = performance.now();
  let first = 0, searches = 0, error = "", cost = 0, promptTokens = 0;
  // Collect token usage from every model call this question makes (router + answer).
  deps.onUsage = (model, u) => { cost += costUsd(model, u); promptTokens += u.inputTokens + u.cacheReadTokens; };
  await runAgent(deps, "bench", q, (e: AgentEvent) => {
    if (e.type === "token" && !first) first = performance.now() - t0;
    if (e.type === "sources") searches++;
    if (e.type === "error") error = e.text;
  });
  return { first, total: performance.now() - t0, searches, error, cost, promptTokens };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  const models = [{ name: "stub", main: createStubModel("stub-main"), fast: createStubModel("stub-fast") }];
  for (const m of models) {
    const deps: AgentDeps = {
      fast: m.fast, main: m.main, search: createStubSearch(),
      memory: memoryStub([{ id: "seed", role: "user", content: "Which Postgres host is cheapest?", createdAt: "2026-11-03T09:00:00Z", conversationId: "old" }]),
      now: () => PINNED_NOW,
    };
    const rows = [];
    for (const q of QUESTIONS) {
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push(await runOne(deps, q)); // median of 3
      rows.push({
        question: q.slice(0, 46),
        firstTokenMs: Math.round(median(runs.map((r) => r.first))),
        totalMs: Math.round(median(runs.map((r) => r.total))),
        searches: runs[0].searches,
        promptTokens: runs[0].promptTokens,
        costUsd: Number(median(runs.map((r) => r.cost)).toFixed(5)),
        error: runs.find((r) => r.error)?.error ?? "",
      });
    }
    console.log(`\n== ${m.name} ==`);
    console.table(rows);
  }
}
main();
