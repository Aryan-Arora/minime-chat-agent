// JSON remains the zero-dependency fallback. The SQLite implementation lives beside it
// and implements the same MemoryStore methods, so the server can switch factories later.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MemoryStore, Message } from "../types.js";

export function createFileMemory(file = path.resolve("data/memory.json")): MemoryStore {
  let cache: Message[] | null = null;

  async function load(): Promise<Message[]> {
    if (cache) return cache;
    try {
      cache = JSON.parse(await fs.readFile(file, "utf8")) as Message[];
    } catch {
      cache = []; // first run or unreadable file: start empty rather than crash
    }
    return cache;
  }

  return {
    async save(msg) {
      const all = await load();
      all.push(msg);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(all, null, 1));
    },
    async between(fromIso, toIso) {
      return (await load()).filter((m) => m.createdAt >= fromIso && m.createdAt < toIso);
    },
    async recent(limit) {
      return (await load()).slice(-limit);
    },
  };
}
