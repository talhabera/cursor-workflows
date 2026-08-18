import { describe, expect, it, vi } from "vitest";
import { spawnDetachedResume } from "./detach.js";

function fakeChild(pid: number | undefined): {
  child: { pid: number | undefined; unref: () => void; on: (event: string, cb: (...args: unknown[]) => void) => void };
  emit: (event: string, ...args: unknown[]) => void;
} {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const child = {
    pid,
    unref() {},
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, cb);
    },
  };
  return {
    child,
    emit: (event, ...args) => handlers.get(event)?.(...args),
  };
}

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
        return fakeChild(4242).child;
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
        return fakeChild(4242).child;
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

  it("attaches an error listener before returning, and forwards a later async spawn error via onError without throwing", () => {
    const { child, emit } = fakeChild(4242);
    const onError = vi.fn();
    const result = spawnDetachedResume({
      cwd: "/repo",
      runId: "cw_1",
      output: "text",
      logPath: "/repo/.cursor-workflows/runs/cw_1/runtime.log",
      spawn: (() => child) as never,
      openLog: () => 3 as never,
      onError,
    });
    expect(result.pid).toBe(4242);
    expect(() => emit("error", new Error("spawn EACCES"))).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("spawn EACCES");
  });

  it("closes the log fd when the child has no pid", () => {
    const { child } = fakeChild(undefined);
    const closeLog = vi.fn();
    expect(() =>
      spawnDetachedResume({
        cwd: "/repo",
        runId: "cw_1",
        output: "text",
        logPath: "/repo/.cursor-workflows/runs/cw_1/runtime.log",
        spawn: (() => child) as never,
        openLog: () => 7 as never,
        closeLog,
      }),
    ).toThrow("failed to spawn detached resume");
    expect(closeLog).toHaveBeenCalledWith(7);
  });

  it("closes the log fd when spawn throws synchronously", () => {
    const closeLog = vi.fn();
    expect(() =>
      spawnDetachedResume({
        cwd: "/repo",
        runId: "cw_1",
        output: "text",
        logPath: "/repo/.cursor-workflows/runs/cw_1/runtime.log",
        spawn: (() => {
          throw new Error("spawn ENOENT");
        }) as never,
        openLog: () => 9 as never,
        closeLog,
      }),
    ).toThrow("spawn ENOENT");
    expect(closeLog).toHaveBeenCalledWith(9);
  });
});
