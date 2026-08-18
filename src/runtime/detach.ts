import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import type { OutputFormat } from "../types.js";

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; detached: boolean; stdio: Array<"ignore" | number> },
) => Pick<ChildProcess, "pid" | "unref" | "on">;

export function spawnDetachedResume(options: {
  cwd: string;
  runId: string;
  output: OutputFormat;
  logPath: string;
  spawn?: SpawnFn;
  execPath?: string;
  execArgv?: string[];
  scriptPath?: string;
  openLog?: (path: string) => number;
  closeLog?: (fd: number) => void;
  onError?: (error: Error) => void;
}): { pid: number } {
  const execPath = options.execPath ?? process.execPath;
  const execArgv = options.execArgv ?? process.execArgv;
  const scriptPath = options.scriptPath ?? process.argv[1] ?? "cw";
  const spawnImpl = options.spawn ?? (spawn as unknown as SpawnFn);
  const closeLogImpl = options.closeLog ?? closeSync;
  const fd = (options.openLog ?? openSync)(options.logPath, "a");

  const safeClose = (): void => {
    try {
      closeLogImpl(fd);
    } catch {
      // already closed or invalid; nothing more we can do
    }
  };

  let child: Pick<ChildProcess, "pid" | "unref" | "on">;
  try {
    child = spawnImpl(
      execPath,
      [...execArgv, scriptPath, "resume", "--run", options.runId, "--output", options.output],
      {
        cwd: options.cwd,
        detached: true,
        stdio: ["ignore", fd, fd],
      },
    );
  } catch (error) {
    safeClose();
    throw error;
  }

  child.on("error", (error) => {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  });
  child.unref();

  const pid = child.pid;
  if (pid === undefined) {
    safeClose();
    throw new Error("failed to spawn detached resume");
  }
  return { pid };
}
