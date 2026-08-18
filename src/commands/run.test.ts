import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCommand } from "./run.js";
import { statusCommand } from "./status.js";
import { workflowsCommand } from "./workflows.js";
import { runFile } from "../store/paths.js";
import type { RunRecord } from "../types.js";
import type { spawnDetachedResume } from "../runtime/detach.js";

async function waitForRunStatus(cwd: string, runId: string, status: string): Promise<RunRecord> {
  const deadline = Date.now() + 2000;
  let last: RunRecord | undefined;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(runFile(cwd, runId, "run.json"), "utf8");
      last = JSON.parse(raw) as RunRecord;
      if (last.status === status) {
        return last;
      }
    } catch {
      // file mid-write; retry
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (last) {
    return last;
  }
  throw new Error(`timed out waiting for run ${runId} to reach status ${status}`);
}

function memoryStream(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer | string) => {
    chunks.push(String(chunk));
  });
  return { stream, text: () => chunks.join("") };
}

describe("cw run with fake backend", () => {
  it("executes a file workflow and records status", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    const file = path.join(cwd, "wf.js");
    await writeFile(
      file,
      `export const meta = { name: "demo", description: "demo" }
const found = await agent("list", {
  schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
  phase: "discover",
})
const out = await pipeline(found.files, (file) => agent("audit " + file, { label: file, phase: "audit" }))
return out
`,
      "utf8",
    );

    const stdout = memoryStream();
    const stderr = memoryStream();
    const code = await runCommand(
      ["--file", file, "--cwd", cwd, "--backend", "fake", "--yes", "--save", "--output", "json"],
      { stdout: stdout.stream, stderr: stderr.stream },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.text()) as { result: unknown; meta: { name: string } };
    expect(payload.meta.name).toBe("demo");
    expect(Array.isArray(payload.result)).toBe(true);

    const statusOut = memoryStream();
    await statusCommand(["--output", "json"], { stdout: statusOut.stream, stderr: stderr.stream }, cwd);
    const status = JSON.parse(statusOut.text()) as {
      run: { status: string; backend: string };
      journal: Array<{ key: string }>;
      events: unknown[];
    };
    expect(status.run.status).toBe("completed");
    expect(status.run.backend).toBe("fake");
    expect(status.journal.length).toBeGreaterThan(0);

    const listOut = memoryStream();
    await workflowsCommand(["list"], { stdout: listOut.stream, stderr: stderr.stream }, cwd);
    expect(listOut.text()).toContain("demo");

    await rm(cwd, { recursive: true, force: true });
  });

  it("marks a detached run failed when the spawn fails synchronously (pid undefined)", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    const file = path.join(cwd, "wf.js");
    await writeFile(
      file,
      `export const meta = { name: "demo", description: "demo" }\nreturn "ok"\n`,
      "utf8",
    );
    const stdout = memoryStream();
    const stderr = memoryStream();

    const spawnResume: typeof spawnDetachedResume = () => {
      throw new Error("failed to spawn detached resume");
    };

    await expect(
      runCommand(
        ["--file", file, "--cwd", cwd, "--backend", "fake", "--yes", "--detach"],
        { stdout: stdout.stream, stderr: stderr.stream },
        { spawnResume },
      ),
    ).rejects.toThrow("failed to spawn detached resume");

    const runDir = path.join(cwd, ".cursor-workflows", "runs");
    const [runId] = await import("node:fs/promises").then((fs) => fs.readdir(runDir));
    const record = JSON.parse(await readFile(runFile(cwd, runId as string, "run.json"), "utf8")) as RunRecord;
    expect(record.status).toBe("failed");
    expect(record.error).toBe("failed to spawn detached resume");

    await rm(cwd, { recursive: true, force: true });
  });

  it("marks a detached run failed when the spawned child later reports an async error", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    const file = path.join(cwd, "wf.js");
    await writeFile(
      file,
      `export const meta = { name: "demo", description: "demo" }\nreturn "ok"\n`,
      "utf8",
    );
    const stdout = memoryStream();
    const stderr = memoryStream();

    let capturedOnError: ((error: Error) => void) | undefined;
    const spawnResume: typeof spawnDetachedResume = (opts) => {
      capturedOnError = opts.onError;
      return { pid: 4242 };
    };

    const code = await runCommand(
      ["--file", file, "--cwd", cwd, "--backend", "fake", "--yes", "--detach"],
      { stdout: stdout.stream, stderr: stderr.stream },
      { spawnResume },
    );
    expect(code).toBe(0);

    expect(capturedOnError).toBeDefined();
    capturedOnError?.(new Error("spawn EACCES"));

    const runDir = path.join(cwd, ".cursor-workflows", "runs");
    const [runId] = await import("node:fs/promises").then((fs) => fs.readdir(runDir));
    const record = await waitForRunStatus(cwd, runId as string, "failed");
    expect(record.status).toBe("failed");
    expect(record.error).toBe("spawn EACCES");

    await rm(cwd, { recursive: true, force: true });
  });
});
