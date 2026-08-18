import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { RunRecord } from "../types.js";
import { runDir, runFile, runRoot } from "./paths.js";

export function newRunId(): string {
  return `cw_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export async function writeRun(cwd: string, record: RunRecord): Promise<void> {
  const dir = runDir(cwd, record.id);
  await mkdir(dir, { recursive: true });
  const next: RunRecord = { ...record, updatedAt: new Date().toISOString() };
  await writeFile(runFile(cwd, record.id, "run.json"), `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export async function readRun(cwd: string, runId: string): Promise<RunRecord> {
  const raw = await readFile(runFile(cwd, runId, "run.json"), "utf8");
  return JSON.parse(raw) as RunRecord;
}

export async function updateRun(
  cwd: string,
  runId: string,
  patch: Partial<RunRecord>,
): Promise<RunRecord> {
  const current = await readRun(cwd, runId);
  const next: RunRecord = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(runFile(cwd, runId, "run.json"), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export async function writeWorkflowSource(cwd: string, runId: string, source: string): Promise<string> {
  const filePath = runFile(cwd, runId, "workflow.js");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, source.endsWith("\n") ? source : `${source}\n`, "utf8");
  return filePath;
}

export async function writeResult(cwd: string, runId: string, result: unknown): Promise<void> {
  await writeFile(runFile(cwd, runId, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export async function listRuns(cwd: string): Promise<RunRecord[]> {
  try {
    const ids = await readdir(runRoot(cwd));
    const records: RunRecord[] = [];
    for (const id of ids) {
      try {
        records.push(await readRun(cwd, id));
      } catch {
        // skip malformed run dirs
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function resolveRunId(cwd: string, runId: string | undefined): Promise<string> {
  if (runId) {
    return runId;
  }
  const runs = await listRuns(cwd);
  const latest = runs[0];
  if (!latest) {
    throw new Error("no runs found");
  }
  return latest.id;
}
