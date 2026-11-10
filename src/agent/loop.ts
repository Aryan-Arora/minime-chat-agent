// The agent loop: remember -> route -> (search) -> answer.
//   1. Local memory lookup (milliseconds), then the fast-model router. They are sequential
//      because the router needs the recent turns to rewrite follow-ups; if a slower memory
//      step (FTS, embeddings) is added, run it in parallel with the router.
//   2. If the router says SEARCH, run the search; if search fails, answer anyway and say so.
//   3. Main model writes the answer, streamed. Stable instructions go in `system` (cacheable),
//      everything that changes per question goes in `context`.
// Events are emitted as they happen so the UI feels fast.
import { randomUUID } from "node:crypto";
import { resolveDate } from "../memory/dates.js";
import type { MemoryStore, Message, ModelAdapter, SearchResult, SearchTool, Usage } from "../types.js";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "token"; text: string }
  | { type: "sources"; sources: { title: string; url: string }[] }
  | { type: "memory"; text: string } // what past material was used, e.g. "3 messages from last tuesday"
  | { type: "error"; text: string }
  | { type: "done" };

export interface AgentDeps {
  fast: ModelAdapter;
  main: ModelAdapter;
  search: SearchTool;
  memory: MemoryStore;
  now?: () => Date; // injectable so the benchmark can pin "today"
  /** Optional: receives token usage for every model call (benchmark cost tracking). */
  onUsage?: (model: string, u: Usage) => void;
}

const ROUTER_SYSTEM = `ROUTER. Decide if the user's latest message needs fresh web information.
Reply with exactly "NO" or "SEARCH: <a concise, self-contained search query>".
Search for: recent events, prices, versions, "what changed since", anything that may have changed.
Do not search for: stable facts, chit-chat, questions about this conversation.
Use the recent conversation to resolve follow-ups ("the second one") into a full query.`;

// Stable on purpose: no dates, no per-question data, so the provider can cache it.
const ANSWER_SYSTEM = `You are a fast, direct chat assistant. Be short, no padding.
When earlier conversation is provided, use its timestamps to answer questions about what was asked and when.
If asked to re-check an earlier answer, compare it with the fresh web results and say plainly what changed and what did not.
Cite web results as [n]. If sources conflict, say so. If the question assumes something that does not exist, say that.
If the question is vague, ask one clarifying question instead of guessing.
If a search failed or returned nothing, say you could not check the web instead of guessing.`;

function buildContext(today: string, pastChat: Message[], results: SearchResult[], searchFailed: boolean): string {
  const parts = [`Today is ${today}.`];
  if (pastChat.length) {
    parts.push(
      `Earlier conversation from the date the user mentioned:\n` +
        pastChat.map((m) => `[${m.createdAt}] ${m.role}: ${m.content}`).join("\n"),
    );
  }
  if (results.length) {
    parts.push(
      `Fresh web results:\n` +
        results
          .map((r, i) => `[${i + 1}] ${r.title} (${r.url})${r.publishedAt ? ` published ${r.publishedAt}` : ""}\n${r.content ?? r.snippet}`)
          .join("\n\n"),
    );
  }
  if (searchFailed) parts.push("The web search failed. Tell the user you could not check the web.");
  return parts.join("\n\n");
}

export async function runAgent(
  deps: AgentDeps,
  conversationId: string,
  userText: string,
  emit: (e: AgentEvent) => void,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const track = (m: ModelAdapter) => (u: Usage) => deps.onUsage?.(m.name, u);
  try {
    const userMsg: Message = {
      id: randomUUID(), role: "user", content: userText, createdAt: now.toISOString(), conversationId,
    };
    emit({ type: "status", text: "Thinking" });

    // Memory lookup happens BEFORE saving this message, so "today" doesn't echo it back.
    const range = resolveDate(userText, now);
    const pastChat = range ? await deps.memory.between(range.from, range.to) : [];
    const thisChat = (await deps.memory.recent(200)).filter((m) => m.conversationId === conversationId).slice(-10);
    if (pastChat.length && range) emit({ type: "memory", text: `${pastChat.length} messages from ${range.label}` });
    await deps.memory.save(userMsg);

    // The router gets the recent turns as ONE classification message (trimmed), not as real
    // chat turns: as real turns a chatty model answers the user instead of classifying, and
    // long earlier answers waste tokens. maxTokens is generous because some models spend part
    // of the budget on hidden reasoning; at 80 that left an empty reply and silently skipped search.
    const transcript = thisChat
      .slice(-4)
      .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
      .join("\n");
    const routerInput = `${transcript ? `Recent conversation:\n${transcript}\n\n` : ""}Latest user message:\n${userText}\n\nReply now with exactly NO or SEARCH: <query>.`;
    const rawRoute = (
      await deps.fast.complete({
        system: ROUTER_SYSTEM,
        messages: [{ role: "user", content: routerInput }],
        maxTokens: 400,
        onUsage: track(deps.fast),
      })
    ).trim();
    // Fail toward searching: an empty or unparseable reply must never mean "skip the web".
    const sm = rawRoute.match(/SEARCH:\s*(.+)/i);
    const query = sm ? sm[1].trim() : /^NO\b/i.test(rawRoute) ? "" : userText.slice(0, 200);
    console.log(`[router] ${JSON.stringify(userText.slice(0, 60))} -> ${query ? `SEARCH ${JSON.stringify(query)}` : "NO"}${rawRoute && !sm && query ? " (unparseable reply, searching anyway)" : ""}`);

    let results: SearchResult[] = [];
    let searchFailed = false;
    if (query) {
      emit({ type: "status", text: `Searching: ${query}` });
      try {
        results = await deps.search.search(query, { maxResults: 5 });
        emit({ type: "sources", sources: results.map((r) => ({ title: r.title, url: r.url })) });
      } catch (err) {
        searchFailed = true; // degrade gracefully: the answer prompt tells the model to say so
        console.error("[search] failed:", err instanceof Error ? err.message : err);
      }
    }

    let answer = "";
    for await (const chunk of deps.main.stream({
      system: ANSWER_SYSTEM,
      context: buildContext(now.toISOString().slice(0, 10), pastChat, results, searchFailed),
      messages: [...thisChat, userMsg].map((m) => ({ role: m.role, content: m.content })),
      onUsage: track(deps.main),
    })) {
      answer += chunk;
      emit({ type: "token", text: chunk });
    }

    await deps.memory.save({
      id: randomUUID(), role: "assistant", content: answer,
      createdAt: new Date().toISOString(), conversationId,
    });
    emit({ type: "done" });
  } catch (err) {
    emit({ type: "error", text: err instanceof Error ? err.message : String(err) });
  }
}
