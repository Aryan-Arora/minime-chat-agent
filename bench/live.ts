// Small paid-API benchmark for the configured fast/main pair. Kept separate from `bench`
// so normal development and CI remain keyless and free.
import { randomUUID } from "node:crypto";
import { runAgent, waitForMemoryTasks, type AgentEvent, type AgentTiming } from "../src/agent/loop.js";
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
  let firstToken = 0, preview = 0, searches = 0, tokens = 0, cost = 0, error = "";
  let timing: AgentTiming | undefined;
  await runAgent({
    fast: models.fast, main: models.main, search: createTavilySearch(), memory,
    onUsage(model, usage) {
      tokens += usage.inputTokens + usage.cacheReadTokens + usage.outputTokens;
      cost += costUsd(model, usage);
    },
    onTiming(value) { timing = value; },
  }, randomUUID(), question, (event: AgentEvent) => {
    if (event.type === "token" && !firstToken) firstToken = performance.now() - started;
    if (event.type === "preview" && !preview) preview = performance.now() - started;
    if (event.type === "sources") searches += 1;
    if (event.type === "error") error = event.text;
  });
  // Include background memory cost in the report without adding it to user-visible latency.
  const userVisibleTotal = performance.now() - started;
  await waitForMemoryTasks();
  rows.push({
    question: question.slice(0, 48), firstTokenMs: Math.round(firstToken),
    previewMs: Math.round(preview),
    totalMs: Math.round(userVisibleTotal), searches, tokens,
    routerMs: timing?.routerMs ?? 0, searchMs: timing?.searchMs ?? 0,
    modelStartupMs: timing?.modelStartupMs ?? 0, streamMs: timing?.streamMs ?? 0,
    costUsd: Number(cost.toFixed(5)), error,
  });
}
console.table(rows);
memory.close();
