# MiniMe chat agent: working notes for Claude

Source of truth: the playbook doc https://claude.ai/artifact/W2EeZVpis6bNJwAViqJhUM (Claude Docs; read it with the Claude Docs connector, ref project id `eb052cef-f7e5-4ef1-8103-ba9ee5b30b9a`). If this file and the doc disagree, the doc wins. Update this file every session.

## Goal
Chat agent whose ONLY tool is web search, as good as the best web-search chatbots. MiniMe judges architecture, code and `DESIGN.md`, not features or looks. Tests are about time and memory: dated chat recall ("what did I ask on 3 Nov"), phrases like "last Tuesday", re-checking old answers with fresh searches, and saying what changed.

## Rules
- JS/TS on Node. `npm install` then `npm run dev` must work. Every key listed in `.env.example`.
- Aryan must be able to explain every decision. Keep code small and readable; comment the why.
- `DESIGN.md` is written by Aryan in his own words. Never write it for him; only feed the decision log.
- Never put real keys in chat or repo. `.env` is gitignored.
- Aryan makes the final call. GPT is the other assistant: I lead agent loop/prompts and memory/date resolver; GPT leads search wrapper, benchmark, UI. Reviewer proposes patches, does not edit the lead's file.
- Settle disagreements by running the benchmark.

## Architecture
1 loop, 2 models (fast router/rewriter, main writer), 1 tool (`web_search`), 1 dated memory. Flagship only for hard questions. Shared interfaces in `src/types.ts` (`Message`, `SearchResult`, `ModelAdapter`) come first.

## Memory design (target; the company is about memory and context management)
Today: flat JSON file (`src/memory/store.ts`); the loop pastes a whole day's raw chat into the prompt. Slow and costly as history grows. Target, in build order:
1. **Notes, not transcripts.** After each answer, a background fast-model call writes a small dated note: topic, claim, sources, search query, volatility (pricing = volatile, a capital = stable). Retrieval injects a few short notes instead of raw chat.
2. **Re-check ledger.** For volatile claims store the query plus a snapshot of key values (e.g. prices). "What changed since last Tuesday?" = rerun the stored query, diff against the snapshot, let the model explain the diff. Structured and cheap, not recalled from memory.
3. **SQLite store** (`better-sqlite3` or `node:sqlite`) with indexes on date and conversation, plus FTS5 full-text search over notes. Replaces the JSON file behind the same `MemoryStore` interface. Embeddings only if keyword search measurably misses.
4. **Layered retrieval, cheapest first:** date resolver (plain code, free) -> time filter -> FTS over notes -> optional embeddings. Router skips memory when the question has no time/past cue; memory lookup runs in parallel with the router.
5. **Cacheable prompts.** Stable prefix first (system prompt, short profile) so provider prompt caching applies; rolling summary of old turns; fixed token budget per prompt section.
6. **Measure it.** Add prompt tokens and cost per question to `bench/`, plus memory-specific questions, and report real numbers in DESIGN.md.
Constraint: the brief allows ONE tool (web search). Memory (including any future internal-docs ingestion) must stay memory the loop reads automatically, never a second tool.

## Ownership right now
Aryan is sending the chat UI (`web/`) and the memory layer (`src/memory/`) to GPT. I (Claude) keep the agent loop, prompts, model adapters and server, and review GPT's work. GPT must code against `src/types.ts` (`MemoryStore`, `Message`) and not change signatures without a note in the status log.

## Layout
src/{types.ts, agent/, models/, tools/search.ts, memory/, server/}, web/, bench/

## Open decisions
- [ ] Deadline (check application form)
- [ ] Search API (page text vs snippets)
- [ ] Which provider keys Aryan has
- [ ] Default fast/main models (after benchmark)
- [ ] Memory store: file vs SQLite (leaning SQLite or JSON file; decide with Aryan)
- [ ] Framework vs thin provider-agnostic layer (leaning thin)
- [ ] Chat UI: minimal page vs framework

## Status log (newest first)
- 2026-11-11: GPT started the personalized-memory layer with additive `UserProfile` and `PreferenceSignal` interfaces, separate SQLite profile storage, and a pure compact profile-prompt builder that ignores low-confidence observations. The UI now has an inspectable, reversible personalization studio for answer depth, tone, structure, recommendations, tables, and opt-in learning; controls persist locally pending Claude's agent-loop/API wiring.
- 2026-11-11: GPT rebuilt the no-build chat UI as a polished responsive research workspace: a calmer ink/violet visual system, clearer research and memory hierarchy, richer starter prompts, translucent focus surfaces, a mobile conversation drawer, and adaptive dark, reduced-motion, reduced-transparency, and high-contrast modes. Chat, streaming, sources, memory provenance, and current-chat deletion behavior are unchanged.
- 2026-11-11: GPT disabled `DELETE /api/memory` with HTTP 410 as a server-side safety guard. Even a stale tab running the retired `Clear all` JavaScript can no longer erase global history; only scoped conversation deletion is allowed.
- 2026-11-11: GPT diagnosed apparent global deletion as stale browser JavaScript: the live server correctly preserved a second chat in a two-conversation scope test, but static assets had no cache policy. Static/UI API responses now use `Cache-Control: no-store`, and CSS/JS URLs are versioned so old destructive handlers cannot survive reloads.
- 2026-11-11: GPT changed the header action from global `Clear all` to scoped `Clear chat`; it deletes only the active conversation plus its notes/ledger, explicitly confirms that other chats remain, and does nothing on an empty new chat.
- 2026-11-11: GPT made answer structure explicit: direct answer first, then short headings, bullets or numbered steps only when complexity warrants them. The safe no-dependency renderer now supports H2/H3, ordered lists, blockquotes, and improved spacing while still escaping all model HTML.
- 2026-11-11: GPT replaced the persistent process log with a post-answer `Sources & context` footer. Live thinking/search/writing remain temporary; the expandable footer now contains only exact memory notes and attributed web sources with domains, available dates, and counts.
- 2026-11-11: Progressive-answer live benchmark: stable capital answer first token 1.47s (no router); cached Node.js quick preview 2.65s, detailed stream 3.73s, total 6.22s; hallucination-trap preview 3.89s, detailed 4.50s, total 6.34s. Preview adds a small Haiku cost but does not alter Sonnet depth.
- 2026-11-11: GPT added stage-level latency measurement and progressive searched answers: the full Sonnet response starts immediately while low-effort Haiku races to show a labeled one-sentence preview, removed when detailed streaming begins. Conservative stable-fact patterns also skip routing; main evidence and depth are unchanged.
- 2026-11-11: Post-optimization live comparison: current Node.js total fell 13.55s -> 7.58s (44%); Postgres hallucination trap 11.27s -> 6.97s (38%); stable fact 4.14s -> 3.36s (19%). A fresh process read the persisted five-result Tavily cache in 1ms. First-token variance remains provider-dependent.
- 2026-11-11: GPT reduced latency without weakening memory: note extraction now runs after `done` but the next same-chat turn awaits it; high-confidence fresh/memory/chitchat routes are deterministic; volatile re-checks skip routing and reuse their stored query; extraction uses Anthropic low effort while the writer remains full quality; Tavily results have a 10-minute persistent SQLite cache.
- 2026-11-11: Live configured-pair benchmark passed with no errors: capital question 2.54s first token / 4.14s total / $0.00057; current Node.js question 6.79s / 13.55s / $0.01518; Postgres hallucination trap 5.27s / 11.27s / $0.01029. Deterministic memory benchmark: 100% top-result accuracy on 3 cases and 95% fewer context characters than transcripts (small synthetic set; do not overclaim).
- 2026-11-11: GPT added an opt-in `bench:live` command for the configured Anthropic/Tavily pair; it records first-token and total latency, searches, tokens, estimated cost, and errors while keeping the default benchmark keyless.
- 2026-11-11: GPT added FTS stop-word handling for date-only recall, search URL deduplication and domain diversity, graceful SQLite shutdown, automated memory integration tests, and a deterministic `bench:memory` report for top-result accuracy and context reduction.
- 2026-11-11: GPT wired compact memory end to end: the fast model extracts validated notes and volatile snapshots after each answer; past-cue requests retrieve up to five dated FTS notes with raw-message fallback; re-checks reuse stored queries, diff fresh snapshots, and show exact note provenance in the UI.
- 2026-11-11: GPT switched the server to SQLite with JSON fallback and one-time legacy migration; SQLite now transactionally implements `clear()` and `deleteConversation()` across messages, notes, FTS, and the re-check ledger while preserving full message history through `recent()` for sidebar/reload.
- 2026-11-10: GPT hardened the memory layer (atomic serialized JSON fallback, validated note extraction, bounded/date-only FTS retrieval, idempotent JSON-to-SQLite import) and redesigned `web/` with a responsive editorial layout, starter prompts, compact provenance, and support for the loop's `memory` SSE event. No agent/server signatures changed.
- 2026-11-10: GPT improved the no-build `web/` UI with persistent streaming activity, source chips, a memory-context disclosure driven by existing `status` events, and tighter phone-width layout; the SSE contract is unchanged.
- 2026-11-10: GPT added additive memory interfaces in `src/types.ts` (`MemoryNote`, snapshots, and `NoteMemoryStore`) without changing existing signatures; implemented a Node SQLite store with date/conversation indexes, FTS5 note retrieval, extraction prompt schema, and volatile-claim re-check ledger. JSON remains the server fallback pending Claude's wiring.
- 2026-11-10: Wrote memory design (notes, re-check ledger, SQLite+FTS, caching). Handing UI + memory layer to GPT; I review.
- 2026-11-10: Anthropic adapter (fetch, streaming) in src/models; auto-used when ANTHROPIC_API_KEY set (defaults haiku-5-5 fast, sonnet-5-5 main). Untested against the live API: no key yet.
- 2026-11-10: Added memory store (JSON file), agent loop, SSE server (port 3040), stub models, bench runner. All run keyless in stub mode; UI verified in browser. Next: real model adapters + keys, benchmark real models.
- 2026-11-10: Created this file; scaffolding repo and shared types.
