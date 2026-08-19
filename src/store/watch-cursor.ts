import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WatchCursor } from "../types.js";
import { runFile } from "./paths.js";

export function emptyWatchCursor(): WatchCursor {
  return { phaseEnds: [], terminal: false };
}

export async function readWatchCursor(cwd: string, runId: string): Promise<WatchCursor> {
  try {
    const raw = await readFile(runFile(cwd, runId, "watch-cursor.json"), "utf8");
    const parsed = JSON.parse(raw) as WatchCursor;
    return {
      phaseEnds: Array.isArray(parsed.phaseEnds) ? parsed.phaseEnds.map(String) : [],
      terminal: parsed.terminal === true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyWatchCursor();
    }
    throw error;
  }
}

export async function writeWatchCursor(cwd: string, runId: string, cursor: WatchCursor): Promise<void> {
  const filePath = runFile(cwd, runId, "watch-cursor.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
}
