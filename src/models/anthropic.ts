// Anthropic adapter over the Messages API using plain fetch (no SDK: fewer moving parts
// to explain). Implements the same ModelAdapter interface as the stub.
import type { CompletionRequest, ModelAdapter, Usage } from "../types.js";

export function createAnthropicModel(model: string, apiKey = process.env.ANTHROPIC_API_KEY): ModelAdapter {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");

  async function call(req: CompletionRequest, stream: boolean): Promise<Response> {
    // Two system blocks: the stable instructions carry cache_control so the provider can
    // reuse them (cache reads are much cheaper); the per-question context comes after,
    // uncached, so changing it never invalidates the cached prefix. Short prefixes under the
    // provider's minimum are simply not cached: harmless.
    const system: object[] = [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }];
    if (req.context) system.push({ type: "text", text: req.context });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 1024,
        system,
        // The API only knows user/assistant; "tool" turns are not used yet.
        messages: req.messages.filter((m) => m.role !== "tool"),
        stream,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    return res;
  }

  const toUsage = (u: any, prev?: Usage): Usage => ({
    inputTokens: u?.input_tokens ?? prev?.inputTokens ?? 0,
    outputTokens: u?.output_tokens ?? prev?.outputTokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? prev?.cacheReadTokens ?? 0,
  });

  return {
    name: model,
    async complete(req) {
      const data = (await (await call(req, false)).json()) as {
        content: { type: string; text?: string }[];
        usage?: unknown;
      };
      req.onUsage?.(toUsage(data.usage));
      return data.content.map((b) => b.text ?? "").join("");
    },
    async *stream(req) {
      const res = await call(req, true);
      const decoder = new TextDecoder();
      let buf = "";
      let usage: Usage | undefined;
      // SSE: events separated by blank lines. We need text deltas, plus usage, which arrives
      // in two pieces: input/cache counts at message_start, output count at message_delta.
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === "message_start") usage = toUsage(ev.message?.usage, usage);
          if (ev.type === "message_delta") usage = toUsage(ev.usage, usage);
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") yield ev.delta.text as string;
          if (ev.type === "error") throw new Error(ev.error?.message ?? "stream error");
        }
      }
      if (usage) req.onUsage?.(usage);
    },
  };
}
