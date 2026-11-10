// USD per 1M tokens. Input/output come from the playbook table (Anthropic's pricing page,
// checked 2026-11-10); only Sonnet's cache-read price ($0.10) was listed there. Haiku and
// Opus cache-read are ASSUMED at 10% of input: verify before quoting in DESIGN.md.
// Unknown models cost 0 so the bench never crashes.
import type { Usage } from "../types.js";

interface Price { input: number; output: number; cacheRead: number }

const PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.4 },
};

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model];
  if (!p) return 0;
  // inputTokens from Anthropic already excludes cache reads, so bill the two separately.
  return (u.inputTokens * p.input + u.cacheReadTokens * p.cacheRead + u.outputTokens * p.output) / 1e6;
}
