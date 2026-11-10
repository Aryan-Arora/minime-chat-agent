// JSON remains the zero-dependency fallback. The SQLite implementation lives beside it
// and implements the same MemoryStore methods, so the server can switch factories later.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MemoryStore, Message } from "../types.js";

export function createFileMemory(file = path.resolve("data/memory.json")): MemoryStore {
  let cache: Message[] | null = null;
  let write = Promise.resolve();

  async function load(): Promise<Message[]> {
    if (cache) return cache;
    try {
      cache = JSON.parse(await fs.readFile(file, "utf8")) as Message[];
    } catch (error) {
      // Missing is a normal first run. Corrupt history must be surfaced, not erased.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      cache = [];
    }
    return cache;
  }

  return {
    async save(msg) {
      // Queue the whole read/append/write operation: first-run loads can overlap too.
      write = write.catch(() => {}).then(async () => {
        const all = await load();
        all.push(msg);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.tmp`;
        await fs.writeFile(temp, JSON.stringify(all, null, 1));
        await fs.rename(temp, file);
      });
      await write;
    },
    async between(fromIso, toIso) {
      return (await load()).filter((m) => m.createdAt >= fromIso && m.createdAt < toIso);
    },
    async recent(limit) {
      if (limit <= 0) return [];
      return (await load()).slice(-limit);
    },
    async deleteConversation(conversationId) {
      write = write.catch(() => {}).then(async () => {
        const kept = (await load()).filter((m) => m.conversationId !== conversationId);
        cache = kept;
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.tmp`;
        await fs.writeFile(temp, JSON.stringify(kept, null, 1));
        await fs.rename(temp, file);
      });
      await write;
    },
    async clear() {
      // Goes through the same write queue so it can't interleave with an in-flight save.
      write = write.catch(() => {}).then(async () => {
        cache = [];
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, "[]");
      });
      await write;
    },
  };
}
