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
  /** Lower effort is useful for constrained routing/extraction; omit for full-quality answers. */
  effort?: "low" | "medium" | "high";
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
  /** Permanently delete all stored history. Optional so stores can adopt it one by one. */
  clear?(): Promise<void>;
  /** Permanently delete one conversation's messages. Optional like clear(). */
  deleteConversation?(conversationId: string): Promise<void>;
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

export type AnswerLength = "concise" | "balanced" | "detailed";
export type AnswerTone = "direct" | "warm" | "formal";
export type AnswerStructure = "prose" | "mixed" | "bullets";

/** A preference is separate from factual memory and always remains inspectable. */
export interface PreferenceSignal {
  key: string;
  value: string;
  confidence: number;
  evidenceCount: number;
  source: "explicit" | "observed";
  lastObservedAt: string;
}

export interface UserProfile {
  id: string;
  answerLength: AnswerLength;
  tone: AnswerTone;
  structure: AnswerStructure;
  technicalDepth: "beginner" | "intermediate" | "expert";
  leadWithRecommendation: boolean;
  showSources: "always" | "when_searched" | "collapsed";
  compareInTables: boolean;
  adaptiveLearning: boolean;
  signals: PreferenceSignal[];
  updatedAt: string;
}

export type MemoryCategory = "preference" | "decision" | "plan" | "personal_fact" | "research_finding";
export type CandidateStatus = "proposed" | "active" | "duplicate" | "superseded" | "rejected" | "forgotten";

/** The durable input to background memory processing. */
export interface MemoryIngestionSource {
  id: string;
  conversationId: string;
  user: Message;
  assistant: Message;
  query?: string;
  sources: string[];
  createdAt: string;
}

export interface MemoryIngestionJob {
  id: string;
  source: MemoryIngestionSource;
  attempts: number;
}

/** A proposed atomic memory. Resolution decides whether it becomes authoritative. */
export interface MemoryCandidate {
  id: string;
  sourceId: string;
  noteId: string;
  conversationId: string;
  subject: string;
  predicate: string;
  object: string;
  category: MemoryCategory;
  confidence: number;
  volatility: NoteVolatility;
  evidence: string[];
  fingerprint: string;
  createdAt: string;
}

export interface StructuredMemory extends MemoryCandidate {
  status: Exclude<CandidateStatus, "proposed" | "duplicate" | "rejected">;
  validFrom: string;
  validTo?: string;
}

export interface CandidateResolution {
  action: "inserted" | "duplicate" | "superseded" | "rejected";
  memoryId?: string;
}

/** SQLite adds compact retrieval without changing the existing MemoryStore contract. */
export interface NoteMemoryStore extends MemoryStore {
  saveNote(note: MemoryNote): Promise<void>;
  retrieve(query: string, dateRange?: MemoryDateRange, limit?: number): Promise<MemoryNote[]>;
  saveRecheck(entry: RecheckEntry): Promise<void>;
  latestRecheck(noteId: string): Promise<RecheckEntry | null>;
  getProfile(id?: string): Promise<UserProfile | null>;
  saveProfile(profile: UserProfile): Promise<void>;
  clearProfile(id?: string): Promise<void>;
  enqueueIngestion(source: MemoryIngestionSource): Promise<string>;
  claimIngestion(): Promise<MemoryIngestionJob | null>;
  completeIngestion(jobId: string): Promise<void>;
  failIngestion(jobId: string, error: string): Promise<void>;
  resolveCandidate(candidate: MemoryCandidate): Promise<CandidateResolution>;
  activeMemories(query?: string, limit?: number): Promise<StructuredMemory[]>;
  forgetMemories(ids: string[]): Promise<number>;
  close(): void;
}
