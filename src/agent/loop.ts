// The agent loop: remember -> route -> (search) -> answer.
//   1. Save the user message (dated).
//   2. If the text refers to a past day, pull that day's chat from memory.
//   3. Fast model decides: answer directly, or search (and with what query).
//   4. Main model writes the answer from memory + search results, streamed.
// Events are emitted as they happen so the UI feels fast.
import { randomUUID } from "node:crypto";
import { resolveDate } from "../memory/dates.js";
import type { MemoryStore, Message, ModelAdapter, SearchResult, SearchTool } from "../types.js";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "token"; text: string }
  | { type: "sources"; sources: { title: string; url: string }[] }
  | { type: "error"; text: string }
  | { type: "done" };

export interface AgentDeps {
  fast: ModelAdapter;
  main: ModelAdapter;
  search: SearchTool;
  memory: MemoryStore;
  now?: () => Date; // injectable so the benchmark can pin "today"
}

const ROUTER_SYSTEM = `ROUTER. Decide if the user's latest message needs fresh web information.
Reply with exactly "NO" or "SEARCH: <a concise, self-contained search query>".
Search for: recent events, prices, versions, "what changed since", anything that may have changed.
Do not search for: stable facts, chit-chat, questions about this conversation.`;

function answerSystem(today: string, pastChat: Message[], results: SearchResult[]): string {
  const past = pastChat.length
    ? `\nEarlier conversation from the date the user mentioned (with timestamps):\n${pastChat
        .map((m) => `[${m.createdAt}] ${m.role}: ${m.content}`)
        .join("\n")}\n`
    : "";
  const web = results.length
    ? `\nFresh web results (cite as [n]):\n${results
        .map((r, i) => `[${i + 1}] ${r.title} (${r.url})${r.publishedAt ? ` published ${r.publishedAt}` : ""}\n${r.content ?? r.snippet}`)
        .join("\n\n")}\n`
    : "";
  return `You are a fast, direct chat assistant. Today is ${today}. Be short, no padding.
If asked to re-check an earlier answer, compare it with the fresh results and say plainly what changed and what did not.
If sources conflict, say so. If the question assumes something that does not exist, say that. If the question is vague, ask one clarifying question.${past}${web}`;
}

export async function runAgent(
  deps: AgentDeps,
  conversationId: string,
  userText: string,
  emit: (e: AgentEvent) => void,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  try {
    const userMsg: Message = {
      id: randomUUID(), role: "user", content: userText, createdAt: now.toISOString(), conversationId,
    };

    // Look up the past day BEFORE saving, so "today" doesn't just echo this message back.
    const range = resolveDate(userText, now);
    const pastChat = range ? await deps.memory.between(range.from, range.to) : [];
    const thisChat = (await deps.memory.recent(200)).filter((m) => m.conversationId === conversationId).slice(-10);
    await deps.memory.save(userMsg);

    emit({ type: "status", text: "Thinking" });
    const route = (
      await deps.fast.complete({
        system: ROUTER_SYSTEM,
        messages: [{ role: "user", content: userText }],
        maxTokens: 60,
      })
    ).trim();

    let results: SearchResult[] = [];
    if (route.startsWith("SEARCH:")) {
      const query = route.slice(7).trim();
      emit({ type: "status", text: `Searching: ${query}` });
      results = await deps.search.search(query, { maxResults: 5 });
      emit({ type: "sources", sources: results.map((r) => ({ title: r.title, url: r.url })) });
    }

    let answer = "";
    for await (const chunk of deps.main.stream({
      system: answerSystem(now.toISOString().slice(0, 10), pastChat, results),
      messages: [...thisChat, userMsg].map((m) => ({ role: m.role, content: m.content })),
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
