import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopCommand } from "./stop.js";
import { CliError } from "../errors.js";
import { writeRun } from "../store/runs.js";
import { runFile } from "../store/paths.js";
import type { RunRecord } from "../types.js";

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

async function withTempDir(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
  try {
    await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("stopCommand", () => {
  describe("selective stop (--phase / --label)", () => {
    let killSpy: ReturnType<typeof vi.spyOn<typeof process, "kill">>;

    beforeEach(() => {
      killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    });

    afterEach(() => {
      killSpy.mockRestore();
    });

    it("appends cancelPhases without SIGTERM semantics in the record", async () => {
      await withTempDir(async (cwd) => {
        const id = "cw_stop_1";
        await writeRun(cwd, record(cwd, id));
        await writeFile(
          runFile(cwd, id, "journal.json"),
          `${JSON.stringify([{ callIndex: 1, key: "b", prompt: "x", label: "b", phase: "verify", status: "running", result: null, tokens: 0, workerId: undefined }], null, 2)}\n`,
          "utf8",
        );
        const stdout = memoryStream();
        const code = await stopCommand(["--run", id, "--phase", "verify"], { stdout: stdout.stream, stderr: stdout.stream }, cwd);
        expect(code).toBe(0);
        const raw = JSON.parse(await readFile(runFile(cwd, id, "run.json"), "utf8")) as RunRecord;
        expect(raw.stopRequested).toBe(false);
        expect(raw.cancelPhases).toEqual(["verify"]);
        expect(stdout.text()).toContain("verify");
        expect(killSpy).not.toHaveBeenCalled();
      });
    });

    it("prints no matching in-flight agents when the phase is idle", async () => {
      await withTempDir(async (cwd) => {
        const id = "cw_stop_2";
        await writeRun(cwd, record(cwd, id));
        await writeFile(runFile(cwd, id, "journal.json"), "[]\n", "utf8");
        const stdout = memoryStream();
        const code = await stopCommand(["--run", id, "--phase", "verify"], { stdout: stdout.stream, stderr: stdout.stream }, cwd);
        expect(code).toBe(0);
        expect(stdout.text()).toContain("no matching in-flight agents");
        const raw = JSON.parse(await readFile(runFile(cwd, id, "run.json"), "utf8")) as RunRecord;
        expect(raw.cancelPhases).toEqual(["verify"]);
        expect(killSpy).not.toHaveBeenCalled();
      });
    });

    it("appends cancelLabels without SIGTERM semantics in the record", async () => {
      await withTempDir(async (cwd) => {
        const id = "cw_stop_3";
        await writeRun(cwd, record(cwd, id));
        await writeFile(
          runFile(cwd, id, "journal.json"),
          `${JSON.stringify([{ callIndex: 1, key: "b", prompt: "x", label: "worker-a", phase: "verify", status: "running", result: null, tokens: 0, workerId: undefined }], null, 2)}\n`,
          "utf8",
        );
        const stdout = memoryStream();
        const code = await stopCommand(["--run", id, "--label", "worker-a"], { stdout: stdout.stream, stderr: stdout.stream }, cwd);
        expect(code).toBe(0);
        const raw = JSON.parse(await readFile(runFile(cwd, id, "run.json"), "utf8")) as RunRecord;
        expect(raw.stopRequested).toBe(false);
        expect(raw.cancelLabels).toEqual(["worker-a"]);
        expect(stdout.text()).toContain("worker-a");
        expect(killSpy).not.toHaveBeenCalled();
      });
    });

    it("prints no matching in-flight agents when the label is idle", async () => {
      await withTempDir(async (cwd) => {
        const id = "cw_stop_4";
        await writeRun(cwd, record(cwd, id));
        await writeFile(runFile(cwd, id, "journal.json"), "[]\n", "utf8");
        const stdout = memoryStream();
        const code = await stopCommand(["--run", id, "--label", "worker-a"], { stdout: stdout.stream, stderr: stdout.stream }, cwd);
        expect(code).toBe(0);
        expect(stdout.text()).toContain("no matching in-flight agents");
        const raw = JSON.parse(await readFile(runFile(cwd, id, "run.json"), "utf8")) as RunRecord;
        expect(raw.cancelLabels).toEqual(["worker-a"]);
        expect(killSpy).not.toHaveBeenCalled();
      });
    });

    it("rejects an empty --phase instead of escalating to a whole-run stop", async () => {
      await withTempDir(async (cwd) => {
        const id = "cw_stop_5";
        await writeRun(cwd, record(cwd, id));
        const stdout = memoryStream();
        await expect(
          stopCommand(["--run", id, "--phase", ""], { stdout: stdout.stream, stderr: stdout.stream }, cwd),
        ).rejects.toBeInstanceOf(CliError);
        expect(killSpy).not.toHaveBeenCalled();
        const raw = JSON.parse(await readFile(runFile(cwd, id, "run.json"), "utf8")) as RunRecord;
        expect(raw.stopRequested).toBe(false);
      });
    });
  });
});
