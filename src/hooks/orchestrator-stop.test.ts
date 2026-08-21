import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { writeRun } from "../store/runs.js";
import { runFile } from "../store/paths.js";
import type { RunRecord } from "../types.js";
import { runOrchestratorStopHook } from "./orchestrator-stop.js";

function memoryStream(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
  return { stream, text: () => chunks.join("") };
}

function record(cwd: string, id: string): RunRecord {
  const now = new Date().toISOString();
  return {
    id,
    status: "completed",
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

describe("runOrchestratorStopHook", () => {
  it("prints {} on aborted", async () => {
    const stdout = memoryStream();
    let watched = 0;
    await runOrchestratorStopHook(
      { status: "aborted", loop_count: 0 },
      {
        stdout: stdout.stream,
        watch: async () => {
          watched += 1;
          return { stdout: "{}", exitCode: 0 };
        },
      },
    );
    expect(stdout.text()).toBe("{}\n");
    expect(watched).toBe(0);
  });

  it("prints {} when there is no watch target", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const stdout = memoryStream();
      await runOrchestratorStopHook(
        { status: "completed", loop_count: 0, workspace_roots: [cwd] },
        { stdout: stdout.stream, cwd },
      );
      expect(stdout.text()).toBe("{}\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns a [cw-watch] followup from watch JSON", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      await writeRun(cwd, { ...record(cwd, "cw_h1"), status: "running" });
      const stdout = memoryStream();
      const snapshot = {
        reason: "phase_end",
        run: { id: "cw_h1" },
        phase: "audit",
        summary: { phase: "audit", ok: 1, failed: 0, cancelled: 0, tokens: 1, labels: ["a"], inFlight: [] },
        resultPreview: null,
      };
      await runOrchestratorStopHook(
        { status: "completed", loop_count: 0, workspace_roots: [cwd] },
        {
          cwd,
          stdout: stdout.stream,
          selectRun: async () => "cw_h1",
          watch: async (args) => {
            expect(args).toEqual(["--run", "cw_h1", "--timeout", "300", "--output", "json"]);
            return { stdout: `${JSON.stringify(snapshot)}\n`, exitCode: 0 };
          },
        },
      );
      const payload = JSON.parse(stdout.text()) as { followup_message: string };
      expect(payload.followup_message).toContain("[cw-watch]");
      expect(payload.followup_message).toContain("reason=phase_end");
      expect(payload.followup_message).toContain("Summarize this to the user");
      expect(payload.followup_message).not.toContain("last automatic check");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("mentions the last automatic check when loop_count is 79", async () => {
    const stdout = memoryStream();
    await runOrchestratorStopHook(
      { status: "completed", loop_count: 79, workspace_roots: ["/repo"] },
      {
        cwd: "/repo",
        stdout: stdout.stream,
        selectRun: async () => "cw_h1",
        watch: async () => ({
          stdout: `${JSON.stringify({ reason: "heartbeat", run: { id: "cw_h1" }, phase: "audit", summary: { phase: "audit", ok: 0, failed: 0, cancelled: 0, tokens: 0, labels: [], inFlight: [] }, resultPreview: null })}\n`,
          exitCode: 0,
        }),
      },
    );
    expect(JSON.parse(stdout.text()).followup_message).toContain("last automatic check");
  });

  it("prints {} when watch fails", async () => {
    const stdout = memoryStream();
    await runOrchestratorStopHook(
      { status: "completed", loop_count: 0, workspace_roots: ["/repo"] },
      {
        cwd: "/repo",
        stdout: stdout.stream,
        selectRun: async () => "cw_h1",
        watch: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(stdout.text()).toBe("{}\n");
  });
});
