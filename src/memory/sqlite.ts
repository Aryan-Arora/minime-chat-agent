import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  MemoryDateRange,
  MemoryNote,
  Message,
  NoteMemoryStore,
  RecheckEntry,
} from "../types.js";

type MessageRow = { id: string; role: Message["role"]; content: string; created_at: string; conversation_id: string };
type NoteRow = {
  id: string; conversation_id: string; created_at: string; topic: string; claim: string;
  sources: string; query: string | null; volatility: MemoryNote["volatility"];
};
type RecheckRow = {
  id: string; note_id: string; conversation_id: string; created_at: string; query: string; snapshot: string;
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

// Quoted word tokens avoid exposing callers to FTS5 operators and malformed MATCH input.
function ftsQuery(input: string): string {
  return (input.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
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
  `);

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
      if (!match || limit <= 0) return [];
      const dateSql = dateRange ? `AND n.created_at >= ? AND n.created_at < ?` : "";
      const params = dateRange
        ? [match, dateRange.from, dateRange.to, limit]
        : [match, limit];
      const rows = db.prepare(`SELECT n.* FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
        WHERE notes_fts MATCH ? ${dateSql} ORDER BY bm25(notes_fts), n.created_at DESC LIMIT ?`)
        .all(...params) as unknown as NoteRow[];
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
    close() { db.close(); },
  };
}
