import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { writeResult, writeRun } from "../store/runs.js";
import { runFile } from "../store/paths.js";
import { readWatchCursor, writeWatchCursor } from "../store/watch-cursor.js";
import type { RunEvent, RunRecord } from "../types.js";
import { selectWatchRun, watchCommand } from "./watch.js";

function memoryStream(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
  return { stream, text: () => chunks.join("") };
}

function record(
  cwd: string,
  id: string,
  status: RunRecord["status"] = "running",
  createdAt?: string,
): RunRecord {
  const now = createdAt ?? new Date().toISOString();
  return {
    id,
    status,
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

async function writeEvents(cwd: string, id: string, events: RunEvent[]): Promise<void> {
  await writeFile(
    runFile(cwd, id, "events.ndjson"),
    events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : ""),
    "utf8",
  );
}

describe("watchCommand", () => {
  it("returns the first unconsumed phase_end immediately and advances the cursor", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const id = "cw_w1";
      await writeRun(cwd, record(cwd, id));
      await writeEvents(cwd, id, [
        { type: "agent_start", at: "t", callIndex: 1, key: "a", label: "a", phase: "audit" },
        { type: "agent_end", at: "t", callIndex: 1, key: "a", ok: true, tokens: 3, phase: "audit" },
        { type: "agent_start", at: "t", callIndex: 2, key: "v", label: "v", phase: "verify" },
      ]);
      const stdout = memoryStream();
      const code = await watchCommand(
        ["--run", id, "--output", "json", "--timeout", "0"],
        { stdout: stdout.stream, stderr: stdout.stream },
        cwd,
        { isPidAlive: () => true },
      );
      expect(code).toBe(0);
      const payload = JSON.parse(stdout.text()) as { reason: string; phase: string };
      expect(payload.reason).toBe("phase_end");
      expect(payload.phase).toBe("audit");
      expect(await readWatchCursor(cwd, id)).toEqual({ phaseEnds: ["audit"], terminal: false });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns phase_end before terminal when both are pending", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const id = "cw_w2";
      await writeRun(cwd, record(cwd, id, "completed"));
      await writeEvents(cwd, id, [
        { type: "agent_start", at: "t", callIndex: 1, key: "a", phase: "audit" },
        { type: "agent_end", at: "t", callIndex: 1, key: "a", ok: true, tokens: 1, phase: "audit" },
      ]);
      await writeResult(cwd, id, { ok: true });
      const first = memoryStream();
      await watchCommand(["--run", id, "--output", "json"], { stdout: first.stream, stderr: first.stream }, cwd, {
        isPidAlive: () => false,
      });
      expect(JSON.parse(first.text()).reason).toBe("phase_end");
      const second = memoryStream();
      await watchCommand(["--run", id, "--output", "json"], { stdout: second.stream, stderr: second.stream }, cwd, {
        isPidAlive: () => false,
      });
      const payload = JSON.parse(second.text()) as { reason: string; resultPreview: unknown };
      expect(payload.reason).toBe("terminal");
      expect(payload.resultPreview).toEqual({ ok: true });
      expect(await readWatchCursor(cwd, id)).toEqual({ phaseEnds: ["audit"], terminal: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns heartbeat after timeout without advancing the cursor", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const id = "cw_w3";
      await writeRun(cwd, record(cwd, id));
      await writeEvents(cwd, id, [
        { type: "agent_start", at: "t", callIndex: 1, key: "a", label: "a", phase: "audit" },
      ]);
      let now = 0;
      const stdout = memoryStream();
      const code = await watchCommand(
        ["--run", id, "--output", "json", "--timeout", "1"],
        { stdout: stdout.stream, stderr: stdout.stream },
        cwd,
        {
          isPidAlive: () => true,
          now: () => now,
          sleep: async () => {
            now = 2000;
          },
        },
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.text()).reason).toBe("heartbeat");
      expect(await readWatchCursor(cwd, id)).toEqual({ phaseEnds: [], terminal: false });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns stale when a running pid is dead and consumes terminal", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const id = "cw_w4";
      await writeRun(cwd, record(cwd, id));
      await writeEvents(cwd, id, [
        { type: "agent_start", at: "t", callIndex: 1, key: "a", phase: "audit" },
      ]);
      const stdout = memoryStream();
      const code = await watchCommand(
        ["--run", id, "--output", "json"],
        { stdout: stdout.stream, stderr: stdout.stream },
        cwd,
        { isPidAlive: () => false },
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.text()).reason).toBe("stale");
      expect(await readWatchCursor(cwd, id)).toEqual({ phaseEnds: [], terminal: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prints help and does not require a run", async () => {
    const stdout = memoryStream();
    const code = await watchCommand(["--help"], { stdout: stdout.stream, stderr: stdout.stream });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("cw watch");
  });
});

describe("selectWatchRun", () => {
  it("returns undefined when there are no runs", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      expect(await selectWatchRun(cwd)).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not select a completed dry-run with no agent events", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const id = "cw_dry";
      await writeRun(cwd, record(cwd, id, "completed"));
      await writeEvents(cwd, id, []);
      expect(await selectWatchRun(cwd, { isPidAlive: () => false })).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not select a run awaiting approval", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const id = "cw_approval";
      await writeRun(cwd, record(cwd, id, "awaiting_approval"));
      await writeEvents(cwd, id, []);
      expect(await selectWatchRun(cwd, { isPidAlive: () => false })).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("selects a running run", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const id = "cw_running";
      await writeRun(cwd, record(cwd, id, "running"));
      await writeEvents(cwd, id, [
        { type: "agent_start", at: "t", callIndex: 1, key: "a", phase: "audit" },
      ]);
      expect(await selectWatchRun(cwd, { isPidAlive: () => true })).toBe(id);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prefers a running run over an older fully consumed completed run", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const consumed = "cw_old";
      const active = "cw_new";
      await writeRun(cwd, record(cwd, consumed, "completed", "2020-01-01T00:00:00.000Z"));
      await writeEvents(cwd, consumed, [
        { type: "agent_start", at: "t", callIndex: 1, key: "a", phase: "audit" },
        { type: "agent_end", at: "t", callIndex: 1, key: "a", ok: true, tokens: 1, phase: "audit" },
      ]);
      await writeResult(cwd, consumed, { ok: true });
      await writeWatchCursor(cwd, consumed, { phaseEnds: ["audit"], terminal: true });
      await writeRun(cwd, record(cwd, active, "running", "2025-01-01T00:00:00.000Z"));
      await writeEvents(cwd, active, [
        { type: "agent_start", at: "t", callIndex: 1, key: "a", label: "a", phase: "audit" },
      ]);
      expect(await selectWatchRun(cwd, { isPidAlive: () => true })).toBe(active);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not select a consumed stale run with a dead pid", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const id = "cw_stale";
      await writeRun(cwd, record(cwd, id, "running"));
      await writeEvents(cwd, id, [
        { type: "agent_start", at: "t", callIndex: 1, key: "a", phase: "audit" },
      ]);
      await writeWatchCursor(cwd, id, { phaseEnds: [], terminal: true });
      expect(await selectWatchRun(cwd, { isPidAlive: () => false })).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("selects a completed run with unconsumed phase_end when nothing is active", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const id = "cw_done";
      await writeRun(cwd, record(cwd, id, "completed"));
      await writeEvents(cwd, id, [
        { type: "agent_start", at: "t", callIndex: 1, key: "a", phase: "audit" },
        { type: "agent_end", at: "t", callIndex: 1, key: "a", ok: true, tokens: 1, phase: "audit" },
      ]);
      await writeResult(cwd, id, { ok: true });
      expect(await selectWatchRun(cwd, { isPidAlive: () => false })).toBe(id);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
