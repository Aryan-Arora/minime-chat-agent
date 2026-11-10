// Tiny HTTP server: serves web/ and streams the agent over SSE at POST /api/chat.
// Plain node:http on purpose: nothing to explain beyond the standard library.
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runAgent, waitForMemoryTasks, type AgentDeps } from "../agent/loop.js";
import { createFileMemory } from "../memory/store.js";
import { createSqliteMemory, migrateJsonMemory } from "../memory/sqlite.js";
import type { MemoryStore, NoteMemoryStore } from "../types.js";
import { createModels } from "../models/index.js";
import { createStubSearch } from "../models/stub.js";
import { createTavilySearch } from "../tools/search.js";

try { process.loadEnvFile(".env"); } catch { /* no .env yet: run in stub mode */ }

const live = Boolean(process.env.SEARCH_API_KEY);
// Each piece goes live independently when its key exists; otherwise a stub stands in.
const models = createModels();
let memory: MemoryStore;
let memoryName = "SQLite";
try {
  const imported = migrateJsonMemory();
  memory = createSqliteMemory();
  if (imported) console.log(`[memory] migrated ${imported} messages from JSON to SQLite`);
} catch (error) {
  // JSON keeps the app usable on runtimes without SQLite; never hide why fallback happened.
  memoryName = "JSON fallback";
  console.warn(`[memory] SQLite unavailable: ${error instanceof Error ? error.message : String(error)}`);
  memory = createFileMemory();
}
const deps: AgentDeps = {
  fast: models.fast,
  main: models.main,
  search: live ? createTavilySearch() : createStubSearch(),
  memory,
};

const WEB = path.resolve("web");
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/chat") {
      let body = "";
      for await (const c of req) body += c;
      const { conversationId, message } = JSON.parse(body) as { conversationId: string; message: string };
      if (!conversationId || !message?.trim()) { res.writeHead(400).end("bad request"); return; }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      await runAgent(deps, conversationId, message, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      res.end();
      return;
    }
    // Delete ONE conversation. The UI confirms first.
    if (req.method === "DELETE" && req.url?.startsWith("/api/conversations/")) {
      const id = decodeURIComponent(req.url.slice("/api/conversations/".length));
      if (!id) { res.writeHead(400).end("missing id"); return; }
      if (!deps.memory.deleteConversation) { res.writeHead(501).end("this memory store cannot delete one chat"); return; }
      await deps.memory.deleteConversation(id);
      console.log(`[memory] deleted conversation ${id}`);
      res.writeHead(204).end();
      return;
    }
    // Sidebar: list every conversation (newest first), or fetch one conversation's messages.
    // Derived from the message log, so it works with any MemoryStore.
    if (req.method === "GET" && req.url?.startsWith("/api/conversations")) {
      const all = await deps.memory.recent(1_000_000);
      const id = decodeURIComponent(req.url.slice("/api/conversations".length).replace(/^\//, ""));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      if (id) {
        res.end(JSON.stringify(all.filter((m) => m.conversationId === id).map(({ role, content, createdAt }) => ({ role, content, createdAt }))));
        return;
      }
      const byConv = new Map<string, { id: string; title: string; updatedAt: string; messages: number }>();
      for (const m of all) {
        const c = byConv.get(m.conversationId) ?? { id: m.conversationId, title: "", updatedAt: m.createdAt, messages: 0 };
        if (!c.title && m.role === "user") c.title = m.content.replace(/\s+/g, " ").slice(0, 60);
        c.updatedAt = m.createdAt > c.updatedAt ? m.createdAt : c.updatedAt;
        c.messages += 1;
        byConv.set(m.conversationId, c);
      }
      res.end(JSON.stringify([...byConv.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))));
      return;
    }
    // Global deletion is intentionally unavailable. This also protects users who still
    // have the old cached "Clear all" JavaScript open in a tab.
    if (req.method === "DELETE" && req.url === "/api/memory") {
      res.writeHead(410, { "content-type": "text/plain", "cache-control": "no-store" })
        .end("Global history deletion is disabled. Delete one conversation instead.");
      return;
    }
    // Static files. The resolve+startsWith check blocks ../ path traversal.
    const pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const rel = pathname === "/" ? "index.html" : pathname;
    const file = path.resolve(WEB, "." + path.sep + rel);
    if (!file.startsWith(WEB + path.sep)) { res.writeHead(403).end(); return; }
    const data = await fs.readFile(file);
    // The UI has no build pipeline to fingerprint assets, so never let an old destructive
    // handler survive a deploy in browser cache.
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    }).end(data);
  } catch {
    if (!res.headersSent) res.writeHead(404).end("not found");
    else res.end();
  }
});
server.listen(Number(process.env.PORT ?? 3040), () =>
  console.log(`http://localhost:${process.env.PORT ?? 3040}  (models: ${models.live ? "Anthropic" : "stub"}, search: ${live ? "Tavily" : "stub"}, memory: ${memoryName})`),
);

// Finish active requests, checkpoint SQLite's WAL, then exit.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(async () => {
    await waitForMemoryTasks();
    (memory as Partial<NoteMemoryStore>).close?.();
    process.exit(0);
  }));
}
