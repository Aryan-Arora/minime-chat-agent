// Tiny HTTP server: serves web/ and streams the agent over SSE at POST /api/chat.
// Plain node:http on purpose: nothing to explain beyond the standard library.
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runAgent, type AgentDeps } from "../agent/loop.js";
import { createFileMemory } from "../memory/store.js";
import { createModels } from "../models/index.js";
import { createStubSearch } from "../models/stub.js";
import { createTavilySearch } from "../tools/search.js";

try { process.loadEnvFile(".env"); } catch { /* no .env yet: run in stub mode */ }

const live = Boolean(process.env.SEARCH_API_KEY);
// Each piece goes live independently when its key exists; otherwise a stub stands in.
const models = createModels();
const deps: AgentDeps = {
  fast: models.fast,
  main: models.main,
  search: live ? createTavilySearch() : createStubSearch(),
  memory: createFileMemory(),
};

const WEB = path.resolve("web");
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

createServer(async (req, res) => {
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
    // Static files. The resolve+startsWith check blocks ../ path traversal.
    const rel = !req.url || req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]);
    const file = path.resolve(WEB, "." + path.sep + rel);
    if (!file.startsWith(WEB + path.sep)) { res.writeHead(403).end(); return; }
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(data);
  } catch {
    if (!res.headersSent) res.writeHead(404).end("not found");
    else res.end();
  }
}).listen(Number(process.env.PORT ?? 3040), () =>
  console.log(`http://localhost:${process.env.PORT ?? 3040}  (models: ${models.live ? "Anthropic" : "stub"}, search: ${live ? "Tavily" : "stub"})`),
);
