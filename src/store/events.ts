import { readFile } from "node:fs/promises";
import type { RunEvent } from "../types.js";

export async function readLastEvents(filePath: string, limit: number = 200): Promise<RunEvent[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const sliced = lines.slice(-limit);
    const events: RunEvent[] = [];
    for (const line of sliced) {
      events.push(JSON.parse(line) as RunEvent);
    }
    return events;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
