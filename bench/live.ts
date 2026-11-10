// Small paid-API benchmark for the configured fast/main pair. Kept separate from `bench`
// so normal development and CI remain keyless and free.
import { randomUUID } from "node:crypto";
import { runAgent, type AgentEvent } from "../src/agent/loop.js";
import { createSqliteMemory } from "../src/memory/sqlite.js";
import { createModels } from "../src/models/index.js";
import { costUsd } from "../src/models/pricing.js";
import { createTavilySearch } from "../src/tools/search.js";

try { process.loadEnvFile(".env"); } catch { /* adapters below provide the useful error */ }
const models = createModels();
if (!models.live || !process.env.SEARCH_API_KEY) throw new Error("bench:live requires ANTHROPIC_API_KEY and SEARCH_API_KEY");
const memory = createSqliteMemory(":memory:");
const questions = [
  "What is the capital of France?",
  "What is the current Node.js LTS version? Cite the sources.",
  "How do I enable the Quantum Mode feature in Postgres 17?",
];
const rows = [];
for (const question of questions) {
  const started = performance.now();
  let firstToken = 0, searches = 0, tokens = 0, cost = 0, error = "";
  await runAgent({
    fast: models.fast, main: models.main, search: createTavilySearch(), memory,
    onUsage(model, usage) {
      tokens += usage.inputTokens + usage.cacheReadTokens + usage.outputTokens;
      cost += costUsd(model, usage);
    },
  }, randomUUID(), question, (event: AgentEvent) => {
    if (event.type === "token" && !firstToken) firstToken = performance.now() - started;
    if (event.type === "sources") searches += 1;
    if (event.type === "error") error = event.text;
  });
  rows.push({
    question: question.slice(0, 48), firstTokenMs: Math.round(firstToken),
    totalMs: Math.round(performance.now() - started), searches, tokens,
    costUsd: Number(cost.toFixed(5)), error,
  });
}
console.table(rows);
memory.close();
