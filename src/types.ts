// Shared interfaces. Everything else codes against these.

export type Role = "user" | "assistant" | "tool";

export interface Message {
  id: string;
  role: Role;
  content: string;
  /** ISO timestamp. Memory and the date resolver depend on this being accurate. */
  createdAt: string;
  conversationId: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Page text if the search API returns it; otherwise undefined. */
  content?: string;
  /** ISO date the page was published or updated, if known. */
  publishedAt?: string;
}

export interface SearchTool {
  search(query: string, opts?: { maxResults?: number; sinceDays?: number }): Promise<SearchResult[]>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache (billed far cheaper). */
  cacheReadTokens: number;
}

export interface CompletionRequest {
  /** Stable instructions. Kept identical across calls so the provider can cache them. */
  system: string;
  /** Per-question material (today's date, memory notes, search results). Never cached. */
  context?: string;
  /** Called once per request with token counts, so benchmarks can compute cost. */
  onUsage?: (u: Usage) => void;
  messages: Pick<Message, "role" | "content">[];
  maxTokens?: number;
}

export interface ModelAdapter {
  name: string;
  /** Streams text chunks; resolves when done. */
  stream(req: CompletionRequest): AsyncIterable<string>;
  complete(req: CompletionRequest): Promise<string>;
}

export interface MemoryStore {
  save(msg: Message): Promise<void>;
  /** Messages whose createdAt falls in [fromIso, toIso). */
  between(fromIso: string, toIso: string): Promise<Message[]>;
  recent(limit: number): Promise<Message[]>;
}
