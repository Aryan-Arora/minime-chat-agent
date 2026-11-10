import { mkdirSync, readFileSync } from "node:fs";
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
    async deleteConversation(conversationId) {
      // Delete derived memory with its transcript so it cannot affect later answers.
      db.exec("BEGIN");
      try {
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
        db.exec("DELETE FROM rechecks; DELETE FROM notes; DELETE FROM messages;");
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
