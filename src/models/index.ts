// Picks real models when a key exists, stubs otherwise, so `npm run dev` always works.
import type { ModelAdapter } from "../types.js";
import { createAnthropicModel } from "./anthropic.js";
import { createStubModel } from "./stub.js";

export function createModels(): { fast: ModelAdapter; main: ModelAdapter; live: boolean } {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      fast: createAnthropicModel(process.env.FAST_MODEL || "claude-haiku-5-5"),
      main: createAnthropicModel(process.env.MAIN_MODEL || "claude-sonnet-5-5"),
      live: true,
    };
  }
  return { fast: createStubModel("stub-fast"), main: createStubModel("stub-main"), live: false };
}
