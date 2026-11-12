import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent, waitForMemoryTasks, type AgentEvent } from "../src/agent/loop.js";
import { diffSnapshots } from "../src/memory/ledger.js";
import { parseNoteExtraction } from "../src/memory/notes.js";
import { buildProfilePrompt, DEFAULT_PROFILE } from "../src/memory/preferences.js";
import { createSqliteMemory } from "../src/memory/sqlite.js";
import type { CompletionRequest, ModelAdapter, SearchTool } from "../src/types.js";

test("note parsing rejects malformed output and snapshot diff stays structured", () => {
  const meta = { id: "n", conversationId: "c", createdAt: "2026-11-10T10:00:00Z" };
  assert.equal(parseNoteExtraction("not json", meta), null);
  assert.deepEqual(diffSnapshots({ price: 10, available: true }, { price: 12, available: true }), [
    { key: "price", before: 10, after: 12 },
  ]);
});

test("agent stores, retrieves and re-checks a volatile note", async () => {
  const memory = createSqliteMemory(":memory:");
  const searched: string[] = [];
  const contexts: string[] = [];
  let snapshotCalls = 0;
  let routerCalls = 0;

  const fast: ModelAdapter = {
    name: "test-fast",
    async complete(req: CompletionRequest) {
      if (req.system.includes("ROUTER")) {
        routerCalls += 1;
        return routerCalls === 1 ? "SEARCH: Acme plan price" : "SEARCH: generic router query";
      }
      if (req.system.includes("current key values")) {
        snapshotCalls += 1;
        return JSON.stringify({ monthly_price_usd: 12 });
      }
      return JSON.stringify({
        topic: "Acme hosting price", claim: "Acme costs $10 monthly",
        sources: [], query: "Acme plan price", volatility: "volatile",
        snapshot: { monthly_price_usd: 10 },
      });
    },
    async *stream(req: CompletionRequest) {
      contexts.push(req.context ?? "");
      yield "Acme costs $10 monthly.";
    },
  };
  const search: SearchTool = {
    async search(query) {
      searched.push(query);
      return [{ title: "Acme pricing", url: "https://example.com/price", snippet: "Acme now costs $12 monthly." }];
    },
  };
  const now = () => new Date("2026-11-10T12:00:00Z");

  await runAgent({ fast, main: fast, search, memory, now }, "chat", "What is the Acme hosting price?", () => {});
  await waitForMemoryTasks("chat");
  const notes = await memory.retrieve("Acme hosting price");
  assert.equal(notes.length, 1);
  assert.deepEqual((await memory.latestRecheck(notes[0].id))?.snapshot, { monthly_price_usd: 10 });

  const events: AgentEvent[] = [];
  await runAgent(
    { fast, main: fast, search, memory, now },
    "chat",
    "Has the Acme hosting price changed since last time?",
    (event) => events.push(event),
  );
  await waitForMemoryTasks("chat");
  assert.equal(searched.at(-1), "What is the Acme hosting price?", "re-check should reuse the exact first query");
  assert.equal(routerCalls, 0, "obvious freshness and stored-query routes should skip the model router");
  assert.equal(snapshotCalls, 1);
  assert.match(contexts.at(-1) ?? "", /"before": 10/);
  assert.match(contexts.at(-1) ?? "", /"after": 12/);
  const memoryEvent = events.find((event) => event.type === "memory");
  assert.ok(memoryEvent?.type === "memory" && memoryEvent.notes?.[0].topic === "Acme hosting price");
  memory.close();
});

test("SQLite conversation deletion removes transcript, notes and ledger", async () => {
  const memory = createSqliteMemory(":memory:");
  await memory.save({ id: "m", role: "user", content: "hello", createdAt: "2026-11-10T00:00:00Z", conversationId: "c" });
  await memory.saveNote({ id: "n", conversationId: "c", createdAt: "2026-11-10T00:00:01Z", topic: "hello", claim: "hello world", sources: [], query: "hello", volatility: "volatile" });
  await memory.saveRecheck({ id: "r", noteId: "n", conversationId: "c", createdAt: "2026-11-10T00:00:02Z", query: "hello", snapshot: { value: 1 } });
  await memory.deleteConversation?.("c");
  assert.equal((await memory.recent(10)).length, 0);
  assert.equal((await memory.retrieve("hello")).length, 0);
  assert.equal(await memory.latestRecheck("n"), null);
  memory.close();
});

test("SQLite stores an inspectable user profile separately from conversations", async () => {
  const memory = createSqliteMemory(":memory:");
  const profile = { ...DEFAULT_PROFILE, answerLength: "concise" as const, updatedAt: "2026-11-11T00:00:00Z" };
  await memory.saveProfile(profile);
  assert.equal((await memory.getProfile())?.answerLength, "concise");
  assert.match(buildProfilePrompt(profile), /Length: concise/);
  await memory.clearProfile();
  assert.equal(await memory.getProfile(), null);
  memory.close();
});

test("a new chat can immediately summarize the previous chat", async () => {
  const memory = createSqliteMemory(":memory:");
  const contexts: string[] = [];
  const model: ModelAdapter = {
    name: "cross-chat-test",
    async complete(req) {
      if (req.system.includes("Extract one compact memory note")) {
        return JSON.stringify({
          topic: "Mars launch plan", claim: "The launch plan uses a reusable rocket in 2028.",
          sources: [], volatility: "stable", snapshot: {},
        });
      }
      return "NO";
    },
    async *stream(req) {
      contexts.push(req.context ?? "");
      yield contexts.length === 1
        ? "The Mars launch plan uses a reusable rocket in 2028."
        : "Your previous chat discussed the Mars launch plan.";
    },
  };
  const search: SearchTool = { async search() { return []; } };
  const now = () => new Date("2026-11-12T10:00:00Z");

  await runAgent({ fast: model, main: model, search, memory, now }, "chat-a", "Plan a Mars launch", () => {});
  const events: AgentEvent[] = [];
  await runAgent(
    { fast: model, main: model, search, memory, now },
    "chat-b",
    "Summarize my previous chat",
    (event) => events.push(event),
  );

  assert.match(contexts[1], /Plan a Mars launch/);
  assert.ok(events.some((event) => event.type === "memory"));
  await waitForMemoryTasks();
  memory.close();
});
