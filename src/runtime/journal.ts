import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JournalEntry } from "../types.js";

export class Journal {
  private readonly entries: JournalEntry[] = [];
  private readonly byKey = new Map<string, JournalEntry>();

  constructor(entries: JournalEntry[] = []) {
    for (const entry of entries) {
      this.entries.push(entry);
      this.byKey.set(entry.key, entry);
    }
  }

  get size(): number {
    return this.entries.length;
  }

  get(key: string): JournalEntry | undefined {
    return this.byKey.get(key);
  }

  completed(key: string): JournalEntry | undefined {
    const entry = this.byKey.get(key);
    if (entry?.status === "completed") {
      return entry;
    }
    return undefined;
  }

  upsert(entry: JournalEntry): void {
    const existing = this.byKey.get(entry.key);
    if (existing) {
      Object.assign(existing, entry);
      return;
    }
    this.entries.push(entry);
    this.byKey.set(entry.key, entry);
  }

  toJSON(): JournalEntry[] {
    return this.entries;
  }

  static async load(filePath: string): Promise<Journal> {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as JournalEntry[];
      return new Journal(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new Journal();
      }
      throw error;
    }
  }

  async save(filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(this.entries, null, 2)}\n`, "utf8");
  }
}
