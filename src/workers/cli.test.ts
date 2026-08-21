import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CliError } from "../errors.js";
import type { WorkerRequest } from "../types.js";
import { CliWorkerBackend } from "./cli.js";

function baseRequest(prompt: string): WorkerRequest {
  return {
    prompt,
    cwd: process.cwd(),
    model: "composer-2.5",
    tools: "read",
    schema: undefined,
    label: undefined,
    phase: undefined,
    isolation: "cwd",
    signal: new AbortController().signal,
  };
}

async function withScript(contents: string, fn: (scriptPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cw-cli-"));
  const scriptPath = path.join(dir, "agent-stub.sh");
  await writeFile(scriptPath, contents, "utf8");
  await chmod(scriptPath, 0o755);
  try {
    await fn(scriptPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("CliWorkerBackend", () => {
  it("maps a missing binary (ENOENT) to a not-found CliError", async () => {
    const backend = new CliWorkerBackend({
      defaultModel: "composer-2.5",
      agentBin: "/nonexistent/cw-agent-binary-does-not-exist",
    });
    await expect(backend.start(baseRequest("hello"))).rejects.toMatchObject({
      name: "CliError",
      message: "agent CLI not found",
    } satisfies Partial<CliError>);
  });

  it("maps a logged-out stderr to a login CliError", async () => {
    await withScript("#!/bin/sh\necho 'Error: not logged in' 1>&2\nexit 1\n", async (scriptPath) => {
      const backend = new CliWorkerBackend({ defaultModel: "composer-2.5", agentBin: scriptPath });
      await expect(backend.start(baseRequest("hello"))).rejects.toMatchObject({
        name: "CliError",
        message: "agent CLI is not logged in",
      });
    });
  });

  it("honors CW_AGENT_BIN when no explicit agentBin option is set", async () => {
    await withScript("#!/bin/sh\necho '{\"result\":\"ok\"}'\nexit 0\n", async (scriptPath) => {
      const prev = process.env.CW_AGENT_BIN;
      process.env.CW_AGENT_BIN = scriptPath;
      try {
        const backend = new CliWorkerBackend({ defaultModel: "composer-2.5" });
        const result = await backend.start(baseRequest("hello"));
        expect(result.status).toBe("finished");
        expect(result.result).toBe("ok");
      } finally {
        if (prev === undefined) {
          delete process.env.CW_AGENT_BIN;
        } else {
          process.env.CW_AGENT_BIN = prev;
        }
      }
    });
  });

  it("stays generic for a failing prompt that contains the word login (no false-positive)", async () => {
    await withScript("#!/bin/sh\necho 'boom, something else broke' 1>&2\nexit 1\n", async (scriptPath) => {
      const backend = new CliWorkerBackend({ defaultModel: "composer-2.5", agentBin: scriptPath });
      await expect(
        backend.start(baseRequest("audit the login route for missing auth")),
      ).rejects.toMatchObject({
        name: "CliError",
        message: expect.stringContaining("cursor CLI worker failed"),
      });
    });
  });
});
