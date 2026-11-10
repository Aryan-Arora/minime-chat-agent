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
- 2026-11-10: Added memory store (JSON file), agent loop, SSE server (port 3040), stub models, bench runner. All run keyless in stub mode; UI verified in browser. Next: real model adapters + keys, benchmark real models.
- 2026-11-10: Created this file; scaffolding repo and shared types.
