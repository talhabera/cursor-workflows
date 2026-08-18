import { spawn, type ChildProcess } from "node:child_process";
import { openSync } from "node:fs";
import type { OutputFormat } from "../types.js";

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; detached: boolean; stdio: Array<"ignore" | number> },
) => Pick<ChildProcess, "pid" | "unref">;

export function spawnDetachedResume(options: {
  cwd: string;
  runId: string;
  output: OutputFormat;
  logPath: string;
  spawn?: SpawnFn;
  execPath?: string;
  scriptPath?: string;
  openLog?: (path: string) => number;
}): { pid: number } {
  const execPath = options.execPath ?? process.execPath;
  const scriptPath = options.scriptPath ?? process.argv[1] ?? "cw";
  const spawnImpl = options.spawn ?? (spawn as unknown as SpawnFn);
  const fd = (options.openLog ?? openSync)(options.logPath, "a");
  const child = spawnImpl(execPath, [scriptPath, "resume", "--run", options.runId, "--output", options.output], {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("failed to spawn detached resume");
  }
  return { pid };
}
