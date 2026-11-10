// Anthropic adapter over the Messages API using plain fetch (no SDK: fewer moving parts
// to explain). Implements the same ModelAdapter interface as the stub.
import type { CompletionRequest, ModelAdapter } from "../types.js";

export function createAnthropicModel(model: string, apiKey = process.env.ANTHROPIC_API_KEY): ModelAdapter {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");

  async function call(req: CompletionRequest, stream: boolean): Promise<Response> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        // The API only knows user/assistant; "tool" turns are not used yet.
        messages: req.messages.filter((m) => m.role !== "tool"),
        stream,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    return res;
  }

  return {
    name: model,
    async complete(req) {
      const data = (await (await call(req, false)).json()) as { content: { type: string; text?: string }[] };
      return data.content.map((b) => b.text ?? "").join("");
    },
    async *stream(req) {
      const res = await call(req, true);
      const decoder = new TextDecoder();
      let buf = "";
      // SSE: events separated by blank lines; we only need text_delta payloads.
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") yield ev.delta.text as string;
          if (ev.type === "error") throw new Error(ev.error?.message ?? "stream error");
        }
      }
    },
  };
}
