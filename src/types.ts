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

export type NoteVolatility = "stable" | "volatile";

/** A compact fact extracted from one completed user/assistant exchange. */
export interface MemoryNote {
  id: string;
  conversationId: string;
  createdAt: string;
  topic: string;
  claim: string;
  sources: string[];
  query?: string;
  volatility: NoteVolatility;
}

export interface MemoryDateRange {
  from: string;
  to: string;
}

/** Values are deliberately scalar so snapshots stay easy to compare and prompt. */
export type SnapshotValue = string | number | boolean | null;

export interface RecheckEntry {
  id: string;
  noteId: string;
  conversationId: string;
  createdAt: string;
  query: string;
  snapshot: Record<string, SnapshotValue>;
}

export interface SnapshotChange {
  key: string;
  before?: SnapshotValue;
  after?: SnapshotValue;
}

/** SQLite adds compact retrieval without changing the existing MemoryStore contract. */
export interface NoteMemoryStore extends MemoryStore {
  saveNote(note: MemoryNote): Promise<void>;
  retrieve(query: string, dateRange?: MemoryDateRange, limit?: number): Promise<MemoryNote[]>;
  saveRecheck(entry: RecheckEntry): Promise<void>;
  latestRecheck(noteId: string): Promise<RecheckEntry | null>;
  close(): void;
}
