import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { memoryFingerprint } from "./ingestion.js";
import type {
  CandidateResolution,
  MemoryDateRange,
  MemoryCandidate,
  MemoryIngestionJob,
  MemoryIngestionSource,
  MemoryNote,
  Message,
  NoteMemoryStore,
  RecheckEntry,
  StructuredMemory,
  UserProfile,
} from "../types.js";

type MessageRow = { id: string; role: Message["role"]; content: string; created_at: string; conversation_id: string };
type NoteRow = {
  id: string; conversation_id: string; created_at: string; topic: string; claim: string;
  sources: string; query: string | null; volatility: MemoryNote["volatility"];
};
type RecheckRow = {
  id: string; note_id: string; conversation_id: string; created_at: string; query: string; snapshot: string;
};
type ProfileRow = { profile_json: string };
type JobRow = { id: string; source_json: string; attempts: number };
type StructuredRow = {
  id: string; source_id: string; note_id: string; conversation_id: string;
  subject: string; predicate: string; object: string; category: MemoryCandidate["category"];
  confidence: number; volatility: MemoryNote["volatility"]; evidence: string; fingerprint: string;
  status: StructuredMemory["status"]; created_at: string; valid_from: string; valid_to: string | null;
};

function message(row: MessageRow): Message {
  return { id: row.id, role: row.role, content: row.content, createdAt: row.created_at, conversationId: row.conversation_id };
}

function note(row: NoteRow): MemoryNote {
  return {
    id: row.id, conversationId: row.conversation_id, createdAt: row.created_at,
    topic: row.topic, claim: row.claim, sources: JSON.parse(row.sources) as string[],
    ...(row.query ? { query: row.query } : {}), volatility: row.volatility,
  };
}

function recheck(row: RecheckRow): RecheckEntry {
  return {
    id: row.id, noteId: row.note_id, conversationId: row.conversation_id,
    createdAt: row.created_at, query: row.query, snapshot: JSON.parse(row.snapshot),
  };
}

function structured(row: StructuredRow): StructuredMemory {
  return {
    id: row.id, sourceId: row.source_id, noteId: row.note_id, conversationId: row.conversation_id,
    subject: row.subject, predicate: row.predicate, object: row.object, category: row.category,
    confidence: row.confidence, volatility: row.volatility, evidence: JSON.parse(row.evidence) as string[],
    fingerprint: row.fingerprint, createdAt: row.created_at, status: row.status,
    validFrom: row.valid_from, ...(row.valid_to ? { validTo: row.valid_to } : {}),
  };
}

function insertCandidate(db: DatabaseSync, value: MemoryCandidate, status: string, evidence: string): void {
  db.prepare(`INSERT OR IGNORE INTO memory_candidates(id, source_id, note_id, conversation_id, subject, predicate, object,
    category, confidence, volatility, evidence, fingerprint, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(value.id, value.sourceId, value.noteId, value.conversationId, value.subject, value.predicate,
      value.object, value.category, value.confidence, value.volatility, evidence, value.fingerprint, status, value.createdAt);
}

function insertStructured(db: DatabaseSync, value: MemoryCandidate, evidence: string): void {
  db.prepare(`INSERT OR IGNORE INTO structured_memories(id, source_id, note_id, conversation_id, subject, predicate, object,
    category, confidence, volatility, evidence, fingerprint, status, created_at, valid_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run(value.id, value.sourceId, value.noteId, value.conversationId, value.subject, value.predicate,
      value.object, value.category, value.confidence, value.volatility, evidence, value.fingerprint,
      value.createdAt, value.createdAt);
}

// Quoted word tokens avoid exposing callers to FTS5 operators and malformed MATCH input.
function ftsQuery(input: string): string {
  const stop = new Set([
    "a", "an", "and", "about", "asked", "before", "changed", "did", "do", "from", "has", "have", "i", "in", "is", "it",
    "last", "me", "my", "now", "on", "re", "remember", "said", "since", "still", "the", "this", "time", "to", "today", "was",
    "we", "what", "when", "which", "you", "your", "yesterday", "january", "february", "march", "april", "may", "june", "july",
    "august", "september", "october", "november", "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  ]);
  return (input.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter((word) => !stop.has(word) && !/^\d{1,4}$/.test(word))
    .map((word) => `"${word.replaceAll('"', '""')}"`)
    .join(" OR ");
}

export function createSqliteMemory(file = path.resolve("data/memory.sqlite")): NoteMemoryStore {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL,
      created_at TEXT NOT NULL, conversation_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_date ON messages(created_at);
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, created_at TEXT NOT NULL,
      topic TEXT NOT NULL, claim TEXT NOT NULL, sources TEXT NOT NULL,
      query TEXT, volatility TEXT NOT NULL CHECK (volatility IN ('stable', 'volatile'))
    );
    CREATE INDEX IF NOT EXISTS notes_date ON notes(created_at);
    CREATE INDEX IF NOT EXISTS notes_conversation ON notes(conversation_id, created_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(topic, claim, content='notes', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, topic, claim) VALUES (new.rowid, new.topic, new.claim);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, topic, claim) VALUES ('delete', old.rowid, old.topic, old.claim);
    END;
    CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, topic, claim) VALUES ('delete', old.rowid, old.topic, old.claim);
      INSERT INTO notes_fts(rowid, topic, claim) VALUES (new.rowid, new.topic, new.claim);
    END;
    CREATE TABLE IF NOT EXISTS rechecks (
      id TEXT PRIMARY KEY, note_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      created_at TEXT NOT NULL, query TEXT NOT NULL, snapshot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rechecks_note ON rechecks(note_id, created_at);
    CREATE INDEX IF NOT EXISTS rechecks_conversation ON rechecks(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_profiles (
      id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_sources (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, source_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_sources_conversation ON memory_sources(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS memory_jobs (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE REFERENCES memory_sources(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
      last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_jobs_ready ON memory_jobs(status, available_at, created_at);
    CREATE TABLE IF NOT EXISTS memory_candidates (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, note_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
      category TEXT NOT NULL, confidence REAL NOT NULL, volatility TEXT NOT NULL,
      evidence TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_candidates_fingerprint ON memory_candidates(fingerprint);
    CREATE INDEX IF NOT EXISTS memory_candidates_conversation ON memory_candidates(conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS structured_memories (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, note_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
      category TEXT NOT NULL, confidence REAL NOT NULL, volatility TEXT NOT NULL,
      evidence TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS structured_memories_fingerprint ON structured_memories(fingerprint) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS structured_memories_lookup ON structured_memories(subject, predicate, status);
    CREATE TABLE IF NOT EXISTS memory_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, candidate_id TEXT,
      action TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forget_tombstones (
      fingerprint TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  // A previous process may have stopped mid-extraction. Its durable jobs are safe to retry.
  db.exec(`UPDATE memory_jobs SET status = 'pending', updated_at = datetime('now') WHERE status = 'processing'`);
  // Notes from earlier versions remain useful. Backfill them without another model call.
  const legacyNotes = db.prepare(`SELECT n.* FROM notes n
    LEFT JOIN structured_memories m ON m.note_id = n.id WHERE m.id IS NULL`).all() as unknown as NoteRow[];
  for (const old of legacyNotes) {
    const fingerprint = memoryFingerprint(old.topic, "states", old.claim);
    if (db.prepare(`SELECT 1 FROM forget_tombstones WHERE fingerprint=?`).get(fingerprint)) continue;
    const id = `legacy:${old.id}`;
    const candidate: MemoryCandidate = {
      id, sourceId: `legacy:${old.id}`, noteId: old.id, conversationId: old.conversation_id,
      subject: old.topic, predicate: "states", object: old.claim, category: "research_finding",
      confidence: .7, volatility: old.volatility, evidence: JSON.parse(old.sources) as string[],
      fingerprint, createdAt: old.created_at,
    };
    const exists = db.prepare(`SELECT 1 FROM structured_memories WHERE fingerprint=? AND status='active'`).get(fingerprint);
    insertCandidate(db, candidate, exists ? "duplicate" : "active", JSON.stringify(candidate.evidence));
    if (exists) continue;
    // Two legacy notes may normalize to one fingerprint; one authoritative copy is enough.
    insertStructured(db, candidate, JSON.stringify(candidate.evidence));
  }

  return {
    async save(msg) {
      db.prepare(`INSERT OR REPLACE INTO messages(id, role, content, created_at, conversation_id) VALUES (?, ?, ?, ?, ?)`)
        .run(msg.id, msg.role, msg.content, msg.createdAt, msg.conversationId);
    },
    async between(fromIso, toIso) {
      const rows = db.prepare(`SELECT * FROM messages WHERE created_at >= ? AND created_at < ? ORDER BY created_at`)
        .all(fromIso, toIso) as unknown as MessageRow[];
      return rows.map(message);
    },
    async recent(limit) {
      const rows = db.prepare(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`)
        .all(Math.max(0, limit)) as unknown as MessageRow[];
      return rows.reverse().map(message);
    },
    async saveNote(value) {
      // UPSERT runs the FTS update trigger; REPLACE can bypass its delete half.
      db.prepare(`INSERT INTO notes(id, conversation_id, created_at, topic, claim, sources, query, volatility)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id,
          created_at=excluded.created_at, topic=excluded.topic, claim=excluded.claim,
          sources=excluded.sources, query=excluded.query, volatility=excluded.volatility`)
        .run(value.id, value.conversationId, value.createdAt, value.topic, value.claim,
          JSON.stringify(value.sources), value.query ?? null, value.volatility);
    },
    async retrieve(query: string, dateRange?: MemoryDateRange, limit = 5) {
      const match = ftsQuery(query);
      const count = Math.min(Math.max(0, Math.floor(limit)), 20);
      if (!count) return [];
      const dateSql = dateRange ? `AND n.created_at >= ? AND n.created_at < ?` : "";
      // A date-only lookup returns the latest notes; otherwise rank topic above claim.
      const sql = match
        ? `SELECT n.* FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
           WHERE notes_fts MATCH ? ${dateSql} ORDER BY bm25(notes_fts, 2.0, 1.0), n.created_at DESC LIMIT ?`
        : `SELECT n.* FROM notes n WHERE 1=1 ${dateSql} ORDER BY n.created_at DESC LIMIT ?`;
      const params = match
        ? (dateRange ? [match, dateRange.from, dateRange.to, count] : [match, count])
        : (dateRange ? [dateRange.from, dateRange.to, count] : [count]);
      const rows = db.prepare(sql).all(...params) as unknown as NoteRow[];
      return rows.map(note);
    },
    async saveRecheck(value) {
      db.prepare(`INSERT OR REPLACE INTO rechecks(id, note_id, conversation_id, created_at, query, snapshot)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(value.id, value.noteId, value.conversationId, value.createdAt, value.query, JSON.stringify(value.snapshot));
    },
    async latestRecheck(noteId) {
      const row = db.prepare(`SELECT * FROM rechecks WHERE note_id = ? ORDER BY created_at DESC LIMIT 1`)
        .get(noteId) as unknown as RecheckRow | undefined;
      return row ? recheck(row) : null;
    },
    async getProfile(id = "default") {
      const row = db.prepare(`SELECT profile_json FROM user_profiles WHERE id = ?`).get(id) as ProfileRow | undefined;
      return row ? JSON.parse(row.profile_json) as UserProfile : null;
    },
    async saveProfile(profile) {
      db.prepare(`INSERT INTO user_profiles(id, profile_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at`)
        .run(profile.id, JSON.stringify(profile), profile.updatedAt);
    },
    async clearProfile(id = "default") {
      db.prepare(`DELETE FROM user_profiles WHERE id = ?`).run(id);
    },
    async enqueueIngestion(source: MemoryIngestionSource) {
      const jobId = `job:${source.id}`;
      const queuedAt = new Date().toISOString();
      db.exec("BEGIN");
      try {
        db.prepare(`INSERT OR IGNORE INTO memory_sources(id, conversation_id, source_json, status, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', ?, ?)`)
          .run(source.id, source.conversationId, JSON.stringify(source), source.createdAt, source.createdAt);
        db.prepare(`INSERT OR IGNORE INTO memory_jobs(id, source_id, status, attempts, available_at, created_at, updated_at)
          VALUES (?, ?, 'pending', 0, ?, ?, ?)`)
          .run(jobId, source.id, queuedAt, queuedAt, queuedAt);
        db.exec("COMMIT");
        return jobId;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async claimIngestion(): Promise<MemoryIngestionJob | null> {
      db.exec("BEGIN IMMEDIATE");
      try {
        const now = new Date().toISOString();
        const row = db.prepare(`SELECT j.id, s.source_json, j.attempts
          FROM memory_jobs j JOIN memory_sources s ON s.id = j.source_id
          WHERE j.status = 'pending' AND j.available_at <= ? AND j.attempts < 3
          ORDER BY j.created_at LIMIT 1`).get(now) as JobRow | undefined;
        if (!row) { db.exec("COMMIT"); return null; }
        db.prepare(`UPDATE memory_jobs SET status='processing', attempts=attempts+1, updated_at=? WHERE id=?`)
          .run(now, row.id);
        db.prepare(`UPDATE memory_sources SET status='processing', updated_at=?
          WHERE id=(SELECT source_id FROM memory_jobs WHERE id=?)`).run(now, row.id);
        db.exec("COMMIT");
        return { id: row.id, source: JSON.parse(row.source_json) as MemoryIngestionSource, attempts: row.attempts + 1 };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async completeIngestion(jobId) {
      const now = new Date().toISOString();
      db.prepare(`UPDATE memory_jobs SET status='complete', last_error=NULL, updated_at=? WHERE id=?`).run(now, jobId);
      db.prepare(`UPDATE memory_sources SET status='complete', updated_at=?
        WHERE id=(SELECT source_id FROM memory_jobs WHERE id=?)`).run(now, jobId);
    },
    async failIngestion(jobId, error) {
      const now = new Date().toISOString();
      const row = db.prepare(`SELECT attempts FROM memory_jobs WHERE id=?`).get(jobId) as { attempts: number } | undefined;
      const status = (row?.attempts ?? 3) >= 3 ? "failed" : "pending";
      db.prepare(`UPDATE memory_jobs SET status=?, last_error=?, available_at=?, updated_at=? WHERE id=?`)
        .run(status, error.slice(0, 500), now, now, jobId);
      db.prepare(`UPDATE memory_sources SET status=?, updated_at=?
        WHERE id=(SELECT source_id FROM memory_jobs WHERE id=?)`).run(status, now, jobId);
    },
    async resolveCandidate(candidate): Promise<CandidateResolution> {
      const evidence = JSON.stringify(candidate.evidence);
      db.exec("BEGIN");
      try {
        const tombstone = db.prepare(`SELECT 1 FROM forget_tombstones WHERE fingerprint=?`).get(candidate.fingerprint);
        if (tombstone) {
          insertCandidate(db, candidate, "rejected", evidence);
          db.exec("COMMIT");
          return { action: "rejected" };
        }
        const exact = db.prepare(`SELECT id FROM structured_memories WHERE fingerprint=? AND status='active'`)
          .get(candidate.fingerprint) as { id: string } | undefined;
        if (exact) {
          insertCandidate(db, candidate, "duplicate", evidence);
          db.prepare(`INSERT INTO memory_revisions(memory_id, candidate_id, action, created_at) VALUES (?, ?, 'duplicate', ?)`)
            .run(exact.id, candidate.id, candidate.createdAt);
          db.exec("COMMIT");
          return { action: "duplicate", memoryId: exact.id };
        }
        const supersedable = candidate.category !== "research_finding";
        const prior = supersedable
          ? db.prepare(`SELECT id FROM structured_memories
              WHERE lower(subject)=lower(?) AND predicate=? AND status='active' ORDER BY created_at DESC LIMIT 1`)
              .get(candidate.subject, candidate.predicate) as { id: string } | undefined
          : undefined;
        insertCandidate(db, candidate, "active", evidence);
        if (prior) {
          db.prepare(`UPDATE structured_memories SET status='superseded', valid_to=? WHERE id=?`)
            .run(candidate.createdAt, prior.id);
          db.prepare(`INSERT INTO memory_revisions(memory_id, candidate_id, action, created_at) VALUES (?, ?, 'superseded', ?)`)
            .run(prior.id, candidate.id, candidate.createdAt);
        }
        insertStructured(db, candidate, evidence);
        db.prepare(`INSERT INTO memory_revisions(memory_id, candidate_id, action, created_at) VALUES (?, ?, 'inserted', ?)`)
          .run(candidate.id, candidate.id, candidate.createdAt);
        db.exec("COMMIT");
        return { action: prior ? "superseded" : "inserted", memoryId: candidate.id };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async activeMemories(query = "", limit = 20) {
      const count = Math.min(Math.max(0, Math.floor(limit)), 100);
      const term = `%${query.trim().toLowerCase()}%`;
      const rows = query.trim()
        ? db.prepare(`SELECT * FROM structured_memories WHERE status='active'
            AND (lower(subject) LIKE ? OR lower(object) LIKE ?) ORDER BY created_at DESC LIMIT ?`).all(term, term, count)
        : db.prepare(`SELECT * FROM structured_memories WHERE status='active' ORDER BY created_at DESC LIMIT ?`).all(count);
      return (rows as unknown as StructuredRow[]).map(structured);
    },
    async forgetMemories(ids) {
      const unique = [...new Set(ids)].slice(0, 50);
      if (!unique.length) return 0;
      let forgotten = 0;
      db.exec("BEGIN");
      try {
        for (const id of unique) {
          const row = db.prepare(`SELECT fingerprint, note_id, source_id FROM structured_memories WHERE id=? AND status='active'`)
            .get(id) as { fingerprint: string; note_id: string; source_id: string } | undefined;
          if (!row) continue;
          db.prepare(`INSERT OR IGNORE INTO forget_tombstones(fingerprint, scope, created_at) VALUES (?, 'memory', ?)`)
            .run(row.fingerprint, new Date().toISOString());
          db.prepare(`DELETE FROM rechecks WHERE note_id=?`).run(row.note_id);
          db.prepare(`DELETE FROM notes WHERE id=?`).run(row.note_id);
          db.prepare(`DELETE FROM memory_revisions WHERE memory_id=? OR candidate_id=?`).run(id, id);
          db.prepare(`DELETE FROM memory_candidates WHERE id=?`).run(id);
          forgotten += Number(db.prepare(`DELETE FROM structured_memories WHERE id=?`).run(id).changes);
          db.prepare(`DELETE FROM memory_sources WHERE id=?`).run(row.source_id);
        }
        db.exec("COMMIT");
        return forgotten;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async deleteConversation(conversationId) {
      // Delete derived memory with its transcript so it cannot affect later answers.
      db.exec("BEGIN");
      try {
        db.prepare(`DELETE FROM memory_revisions WHERE memory_id IN
          (SELECT id FROM structured_memories WHERE conversation_id=?) OR candidate_id IN
          (SELECT id FROM memory_candidates WHERE conversation_id=?)`).run(conversationId, conversationId);
        db.prepare(`DELETE FROM structured_memories WHERE conversation_id = ?`).run(conversationId);
        db.prepare(`DELETE FROM memory_candidates WHERE conversation_id = ?`).run(conversationId);
        db.prepare(`DELETE FROM memory_sources WHERE conversation_id = ?`).run(conversationId);
        db.prepare(`DELETE FROM rechecks WHERE conversation_id = ?`).run(conversationId);
        db.prepare(`DELETE FROM notes WHERE conversation_id = ?`).run(conversationId);
        db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async clear() {
      db.exec("BEGIN");
      try {
        db.exec(`DELETE FROM memory_revisions; DELETE FROM structured_memories; DELETE FROM memory_candidates;
          DELETE FROM memory_sources; DELETE FROM forget_tombstones; DELETE FROM rechecks; DELETE FROM notes; DELETE FROM messages;`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() { db.close(); },
  };
}

/** One-time importer for the old JSON store. INSERT OR IGNORE makes retries safe. */
export function importMessages(dbFile: string, messages: Message[]): number {
  if (dbFile !== ":memory:") mkdirSync(path.dirname(dbFile), { recursive: true });
  // Ensure the schema exists when importing into a brand-new database.
  createSqliteMemory(dbFile).close();
  const db = new DatabaseSync(dbFile);
  let inserted = 0;
  const statement = db.prepare(
    `INSERT OR IGNORE INTO messages(id, role, content, created_at, conversation_id) VALUES (?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    for (const item of messages) inserted += Number(statement.run(item.id, item.role, item.content, item.createdAt, item.conversationId).changes);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  return inserted;
}

/** Import the legacy JSON log once. The marker prevents deleted chats returning on restart. */
export function migrateJsonMemory(
  jsonFile = path.resolve("data/memory.json"),
  dbFile = path.resolve("data/memory.sqlite"),
): number {
  let messages: Message[];
  try {
    messages = JSON.parse(readFileSync(jsonFile, "utf8")) as Message[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error; // corrupt history is surfaced rather than silently discarded
  }
  if (!Array.isArray(messages)) throw new Error(`${jsonFile} must contain a message array`);

  createSqliteMemory(dbFile).close();
  const db = new DatabaseSync(dbFile);
  const marker = "legacy-json-v1";
  if (db.prepare(`SELECT 1 FROM metadata WHERE key = ?`).get(marker)) { db.close(); return 0; }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO messages(id, role, content, created_at, conversation_id) VALUES (?, ?, ?, ?, ?)`,
  );
  let imported = 0;
  db.exec("BEGIN");
  try {
    for (const item of messages) {
      if (!item?.id || !item.createdAt || !item.conversationId) throw new Error("legacy memory contains an invalid message");
      imported += Number(insert.run(item.id, item.role, item.content, item.createdAt, item.conversationId).changes);
    }
    db.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)`).run(marker, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  return imported;
}
