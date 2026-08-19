import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeRun } from "./runs.js";
import { runFile } from "./paths.js";
import { emptyWatchCursor, readWatchCursor, writeWatchCursor } from "./watch-cursor.js";
import type { RunRecord } from "../types.js";

function record(cwd: string, id: string): RunRecord {
  const now = new Date().toISOString();
  return {
    id,
    status: "running",
    cwd,
    backend: "fake",
    model: "composer-2.5",
    createdAt: now,
    updatedAt: now,
    pid: 1,
    stopRequested: false,
    cancelPhases: [],
    cancelLabels: [],
    workflowPath: runFile(cwd, id, "workflow.js"),
    prompt: undefined,
    args: undefined,
    size: "medium",
    concurrency: 4,
    maxAgents: 100,
    error: undefined,
    agentCount: 0,
    tokens: 0,
  };
}

describe("watch-cursor", () => {
  it("returns an empty cursor when the file is missing", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      await writeRun(cwd, record(cwd, "cw_1"));
      expect(await readWatchCursor(cwd, "cw_1")).toEqual(emptyWatchCursor());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("round-trips a cursor", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      await writeRun(cwd, record(cwd, "cw_1"));
      await writeWatchCursor(cwd, "cw_1", { phaseEnds: ["audit"], terminal: true });
      expect(await readWatchCursor(cwd, "cw_1")).toEqual({
        phaseEnds: ["audit"],
        terminal: true,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
