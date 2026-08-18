import { describe, expect, it } from "vitest";
import { spawnDetachedResume } from "./detach.js";

describe("spawnDetachedResume", () => {
  it("spawns cw resume for the same run id", () => {
    const spawned: unknown[] = [];
    const result = spawnDetachedResume({
      cwd: "/repo",
      runId: "cw_1",
      output: "json",
      logPath: "/repo/.cursor-workflows/runs/cw_1/runtime.log",
      execPath: "/usr/bin/node",
      scriptPath: "/pkg/dist/cli.js",
      execArgv: [],
      spawn: ((file, args, options) => {
        spawned.push({ file, args, options });
        return { pid: 4242, unref() {}, stdio: [] };
      }) as never,
      openLog: () => 3 as never,
    });
    expect(result.pid).toBe(4242);
    const call = spawned[0] as { file: string; args: string[]; options: { cwd: string; detached: boolean } };
    expect(call.file).toBe("/usr/bin/node");
    expect(call.args).toEqual(["/pkg/dist/cli.js", "resume", "--run", "cw_1", "--output", "json"]);
    expect(call.options.cwd).toBe("/repo");
    expect(call.options.detached).toBe(true);
  });

  it("prefixes the script path with provided exec arguments", () => {
    const spawned: unknown[] = [];
    spawnDetachedResume({
      cwd: "/repo",
      runId: "cw_1",
      output: "text",
      logPath: "/repo/.cursor-workflows/runs/cw_1/runtime.log",
      execPath: "/usr/bin/node",
      scriptPath: "/pkg/src/cli.ts",
      execArgv: ["--import", "tsx"],
      spawn: ((file, args, options) => {
        spawned.push({ file, args, options });
        return { pid: 4242, unref() {}, stdio: [] };
      }) as never,
      openLog: () => 3 as never,
    });

    const call = spawned[0] as { args: string[] };
    expect(call.args).toEqual([
      "--import",
      "tsx",
      "/pkg/src/cli.ts",
      "resume",
      "--run",
      "cw_1",
      "--output",
      "text",
    ]);
  });
});
