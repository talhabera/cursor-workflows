import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCommand } from "./run.js";

function memoryStream(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer | string) => {
    chunks.push(String(chunk));
  });
  return { stream, text: () => chunks.join("") };
}

describe("cw run --detach", () => {
  it("ignores --detach on dry-run", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    const file = path.join(cwd, "wf.js");
    await writeFile(file, `export const meta = { name: "d", description: "d" }\nreturn 1\n`, "utf8");
    const stdout = memoryStream();
    const stderr = memoryStream();
    let spawned = 0;
    const code = await runCommand(
      ["--file", file, "--cwd", cwd, "--backend", "fake", "--dry-run", "--detach"],
      { stdout: stdout.stream, stderr: stderr.stream },
      {
        spawnResume: () => {
          spawned += 1;
          return { pid: 1 };
        },
      },
    );
    expect(code).toBe(0);
    expect(spawned).toBe(0);
    await rm(cwd, { recursive: true, force: true });
  });

  it("detaches by spawning resume and exiting 0", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    const file = path.join(cwd, "wf.js");
    await writeFile(file, `export const meta = { name: "d", description: "d" }\nreturn 1\n`, "utf8");
    const stdout = memoryStream();
    const stderr = memoryStream();
    let spawned: { runId: string } | undefined;
    const code = await runCommand(
      ["--file", file, "--cwd", cwd, "--backend", "fake", "--yes", "--detach"],
      { stdout: stdout.stream, stderr: stderr.stream },
      {
        spawnResume: (options) => {
          spawned = { runId: options.runId };
          return { pid: 99 };
        },
      },
    );
    expect(code).toBe(0);
    expect(spawned?.runId).toMatch(/^cw_/);
    expect(stderr.text()).toContain("run:");
    await rm(cwd, { recursive: true, force: true });
  });
});
