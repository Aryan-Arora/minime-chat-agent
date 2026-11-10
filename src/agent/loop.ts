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
import { diffSnapshots } from "../memory/ledger.js";
import {
  buildNoteExtractionPrompt,
  buildSnapshotExtractionPrompt,
  NOTE_EXTRACTION_SYSTEM,
  parseNoteExtraction,
  parseSnapshot,
  SNAPSHOT_EXTRACTION_SYSTEM,
  snapshotFromNoteExtraction,
} from "../memory/notes.js";
import type {
  MemoryNote, MemoryStore, Message, ModelAdapter, NoteMemoryStore, SearchResult,
  SearchTool, SnapshotChange, Usage,
} from "../types.js";

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "preview"; text: string }
  | { type: "token"; text: string }
  | { type: "sources"; sources: { title: string; url: string }[] }
  | { type: "memory"; text: string; notes?: Pick<MemoryNote, "topic" | "claim" | "createdAt" | "volatility">[] }
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
  onTiming?: (timing: AgentTiming) => void;
}

export interface AgentTiming {
  memoryMs: number;
  routerMs: number;
  searchMs: number;
  snapshotMs: number;
  modelStartupMs: number;
  streamMs: number;
  totalMs: number;
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

const PREVIEW_SYSTEM = `Give one provisional sentence from the supplied web evidence so the user has an immediate orientation.
Cite sources as [n]. If the evidence is uncertain or conflicting, say so. Do not add detail and do not guess.`;

function buildContext(
  today: string,
  pastChat: Message[],
  notes: MemoryNote[],
  results: SearchResult[],
  searchFailed: boolean,
  changes: SnapshotChange[],
): string {
  const parts = [`Today is ${today}.`];
  if (notes.length) {
    parts.push(
      `Relevant memory notes (compact records, not fresh evidence):\n` +
        notes.map((note) => `[${note.createdAt}] ${note.topic}: ${note.claim}`).join("\n"),
    );
  }
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
  if (changes.length) {
    parts.push(`Structured changes since the saved snapshot:\n${JSON.stringify(changes, null, 2)}`);
  }
  return parts.join("\n\n");
}

function noteStore(memory: MemoryStore): NoteMemoryStore | null {
  const candidate = memory as Partial<NoteMemoryStore>;
  return typeof candidate.retrieve === "function" && typeof candidate.saveNote === "function"
    ? candidate as NoteMemoryStore
    : null;
}

const PAST_CUE = /\b(remember|earlier|previous|before|last time|we discussed|we decided|i asked|you said|re-?check|changed since|still)\b/i;
const RECHECK_CUE = /\b(re-?check|changed|change since|still|now|current|latest|today)\b/i;
const FRESH_CUE = /\b(latest|current|today|news|price|pricing|version|release|available|availability)\b/i;
const AMBIGUOUS_REFERENCE = /\b(it|they|them|that|those|one|ones|second|first|best)\b/i;
const STABLE_CUE = /\b(capital of|chemical symbol for|square root of|who wrote|author of)\b/i;
const pendingMemory = new Map<string, Promise<void>>();

/** Tests and graceful shutdown use this; normal requests only await their own conversation. */
export async function waitForMemoryTasks(conversationId?: string): Promise<void> {
  if (conversationId) await pendingMemory.get(conversationId);
  else await Promise.allSettled([...pendingMemory.values()]);
}

export async function runAgent(
  deps: AgentDeps,
  conversationId: string,
  userText: string,
  emit: (e: AgentEvent) => void,
): Promise<void> {
  const started = performance.now();
  let memoryDone = started, routeStarted = started, routeDone = started;
  let searchStarted = 0, searchDone = 0, snapshotStarted = 0, snapshotDone = 0;
  let modelStarted = 0, firstTokenAt = 0, modelDone = 0;
  const now = (deps.now ?? (() => new Date()))();
  const track = (m: ModelAdapter) => (u: Usage) => deps.onUsage?.(m.name, u);
  try {
    // A fast follow-up must see the note from the turn that just finished streaming.
    await waitForMemoryTasks(conversationId);
    const userMsg: Message = {
      id: randomUUID(), role: "user", content: userText, createdAt: now.toISOString(), conversationId,
    };
    emit({ type: "status", text: "Thinking" });

    // Memory lookup happens BEFORE saving this message, so "today" doesn't echo it back.
    const range = resolveDate(userText, now);
    const compact = noteStore(deps.memory);
    const shouldRecall = Boolean(range || PAST_CUE.test(userText));
    // Note retrieval and recent-chat loading are independent and run together.
    const [retrievedNotes, recent] = await Promise.all([
      compact && shouldRecall ? compact.retrieve(userText, range ?? undefined, 5) : Promise.resolve([]),
      deps.memory.recent(200),
    ]);
    // Old history may predate note extraction, so raw dated messages are a temporary fallback.
    const pastChat = !retrievedNotes.length && range ? await deps.memory.between(range.from, range.to) : [];
    const thisChat = recent.filter((m) => m.conversationId === conversationId).slice(-10);
    memoryDone = performance.now();
    if (retrievedNotes.length) {
      emit({
        type: "memory",
        text: `${retrievedNotes.length} relevant note${retrievedNotes.length === 1 ? "" : "s"}`,
        notes: retrievedNotes.map(({ topic, claim, createdAt, volatility }) => ({ topic, claim, createdAt, volatility })),
      });
    } else if (pastChat.length && range) {
      emit({ type: "memory", text: `${pastChat.length} messages from ${range.label}` });
    }
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
    const volatileNote = retrievedNotes.find((note) => note.volatility === "volatile" && note.query);
    const previousSnapshot = compact && volatileNote && RECHECK_CUE.test(userText)
      ? await compact.latestRecheck(volatileNote.id)
      : null;
    let query: string;
    let routeSource: string;
    routeStarted = performance.now();
    if (previousSnapshot && volatileNote?.query) {
      // Re-checks already have the exact query that produced the old snapshot.
      query = volatileNote.query;
      routeSource = "stored query";
    } else if (shouldRecall && !FRESH_CUE.test(userText)) {
      query = "";
      routeSource = "memory-only rule";
    } else if (FRESH_CUE.test(userText) && !AMBIGUOUS_REFERENCE.test(userText)) {
      query = userText.slice(0, 200);
      routeSource = "freshness rule";
    } else if (STABLE_CUE.test(userText)) {
      query = "";
      routeSource = "stable-fact rule";
    } else if (/^\s*(hi|hello|hey|thanks|thank you|good (morning|afternoon|evening))\b/i.test(userText)) {
      query = "";
      routeSource = "chitchat rule";
    } else {
      const rawRoute = (
        await deps.fast.complete({
          system: ROUTER_SYSTEM,
          messages: [{ role: "user", content: routerInput }],
          maxTokens: 400,
          effort: "medium",
          onUsage: track(deps.fast),
        })
      ).trim();
      // Fail toward searching: an empty or unparseable reply must never mean "skip the web".
      const sm = rawRoute.match(/SEARCH:\s*(.+)/i);
      query = sm ? sm[1].trim() : /^NO\b/i.test(rawRoute) ? "" : userText.slice(0, 200);
      routeSource = sm || /^NO\b/i.test(rawRoute) ? "model" : "model fallback";
    }
    routeDone = performance.now();
    console.log(`[router] ${JSON.stringify(userText.slice(0, 60))} -> ${query ? `SEARCH ${JSON.stringify(query)}` : "NO"} (${routeSource})`);

    let results: SearchResult[] = [];
    let searchFailed = false;
    let changes: SnapshotChange[] = [];
    if (query) {
      searchStarted = performance.now();
      emit({ type: "status", text: `Searching: ${query}` });
      try {
        results = await deps.search.search(query, { maxResults: 5 });
        emit({ type: "sources", sources: results.map((r) => ({ title: r.title, url: r.url })) });
      } catch (err) {
        searchFailed = true; // degrade gracefully: the answer prompt tells the model to say so
        console.error("[search] failed:", err instanceof Error ? err.message : err);
      }
      searchDone = performance.now();
    }

    if (compact && volatileNote && previousSnapshot && results.length) {
      snapshotStarted = performance.now();
      const rawSnapshot = await deps.fast.complete({
        system: SNAPSHOT_EXTRACTION_SYSTEM,
        messages: [{ role: "user", content: buildSnapshotExtractionPrompt(volatileNote.claim, previousSnapshot.snapshot, results) }],
        // Reasoning models may spend much of this budget invisibly before emitting JSON.
        maxTokens: 1400,
        effort: "low",
        onUsage: track(deps.fast),
      });
      const currentSnapshot = parseSnapshot(rawSnapshot);
      if (Object.keys(currentSnapshot).length) {
        changes = diffSnapshots(previousSnapshot.snapshot, currentSnapshot);
        await compact.saveRecheck({
          id: randomUUID(), noteId: volatileNote.id, conversationId,
          createdAt: now.toISOString(), query, snapshot: currentSnapshot,
        });
      }
      snapshotDone = performance.now();
    }

    let answer = "";
    modelStarted = performance.now();
    const mainIterator = deps.main.stream({
      system: ANSWER_SYSTEM,
      context: buildContext(now.toISOString().slice(0, 10), pastChat, retrievedNotes, results, searchFailed, changes),
      messages: [...thisChat, userMsg].map((m) => ({ role: m.role, content: m.content })),
      onUsage: track(deps.main),
    })[Symbol.asyncIterator]();
    // Start the full answer immediately. A cheap preview races it but never delays or
    // changes the main request; if the main model wins, no preview is shown.
    const firstMain = mainIterator.next();
    let first = await (async () => {
      if (!query || !results.length) return firstMain;
      const evidence = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`).join("\n\n");
      const preview = deps.fast.complete({
        system: PREVIEW_SYSTEM,
        context: evidence,
        messages: [{ role: "user", content: userText }],
        maxTokens: 500,
        effort: "low",
        onUsage: track(deps.fast),
      }).catch(() => "");
      const winner = await Promise.race([
        firstMain.then((value) => ({ kind: "main" as const, value })),
        preview.then((text) => ({ kind: "preview" as const, text })),
      ]);
      if (winner.kind === "main") return winner.value;
      if (winner.text.trim()) emit({ type: "preview", text: winner.text.trim() });
      return firstMain;
    })();
    while (!first.done) {
      const chunk = first.value;
      if (!firstTokenAt) firstTokenAt = performance.now();
      answer += chunk;
      emit({ type: "token", text: chunk });
      first = await mainIterator.next();
    }
    modelDone = performance.now();

    const assistantMsg: Message = {
      id: randomUUID(), role: "assistant", content: answer,
      createdAt: new Date().toISOString(), conversationId,
    };
    await deps.memory.save(assistantMsg);

    deps.onTiming?.({
      memoryMs: Math.round(memoryDone - started),
      routerMs: Math.round(routeDone - routeStarted),
      searchMs: Math.round(searchDone && searchStarted ? searchDone - searchStarted : 0),
      snapshotMs: Math.round(snapshotDone && snapshotStarted ? snapshotDone - snapshotStarted : 0),
      modelStartupMs: Math.round((firstTokenAt || modelDone) - modelStarted),
      streamMs: Math.round(modelDone - (firstTokenAt || modelStarted)),
      totalMs: Math.round(performance.now() - started),
    });
    emit({ type: "done" });
    if (compact) {
      const task = (async () => {
        try {
        const rawNote = await deps.fast.complete({
          system: NOTE_EXTRACTION_SYSTEM,
          messages: [{
            role: "user",
            content: buildNoteExtractionPrompt(userMsg, assistantMsg, {
              ...(query ? { query } : {}),
              sources: results.map((result) => result.url),
            }),
          }],
          maxTokens: 1400,
          effort: "low",
          onUsage: track(deps.fast),
        });
        const parsed = parseNoteExtraction(rawNote, {
          id: randomUUID(), conversationId, createdAt: assistantMsg.createdAt,
        });
        if (parsed) {
          const savedNote: MemoryNote = {
            ...parsed,
            ...(query ? { query } : {}),
            sources: results.length ? results.map((result) => result.url) : parsed.sources,
          };
          await compact.saveNote(savedNote);
          const snapshot = snapshotFromNoteExtraction(rawNote);
          if (savedNote.volatility === "volatile" && savedNote.query && Object.keys(snapshot).length) {
            await compact.saveRecheck({
              id: randomUUID(), noteId: savedNote.id, conversationId,
              createdAt: assistantMsg.createdAt, query: savedNote.query, snapshot,
            });
          }
        }
        } catch (error) {
        // The answer is already safely stored; extraction failure must not fail the turn.
        console.warn("[memory] note extraction failed:", error instanceof Error ? error.message : error);
        }
      })();
      pendingMemory.set(conversationId, task);
      void task.finally(() => {
        if (pendingMemory.get(conversationId) === task) pendingMemory.delete(conversationId);
      });
    }
  } catch (err) {
    emit({ type: "error", text: err instanceof Error ? err.message : String(err) });
  }
}
