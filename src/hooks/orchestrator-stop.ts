import { execa } from "execa";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WATCH_TIMEOUT_SEC } from "../constants.js";
import { selectWatchRun } from "../commands/watch.js";
import type { CommandIo } from "../commands/run.js";

export interface StopHookInput {
  status?: string;
  loop_count?: number;
  workspace_roots?: string[];
}

export interface StopHookHooks {
  cwd?: string;
  stdout?: CommandIo["stdout"];
  selectRun?: (cwd: string) => Promise<string | undefined>;
  watch?: (args: string[]) => Promise<{ stdout: string; exitCode: number }>;
  cliPath?: string;
}

function packageCliPath(from: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(from)), "../../dist/cli.js");
}

function empty(stdout: CommandIo["stdout"]): void {
  stdout.write("{}\n");
}

export async function runOrchestratorStopHook(
  input: StopHookInput,
  hooks: StopHookHooks = {},
): Promise<void> {
  const stdout = hooks.stdout ?? process.stdout;
  try {
    if (input.status === "aborted") {
      empty(stdout);
      return;
    }
    const cwd = hooks.cwd ?? input.workspace_roots?.[0] ?? process.cwd();
    const runId = await (hooks.selectRun ?? selectWatchRun)(cwd);
    if (!runId) {
      empty(stdout);
      return;
    }
    const args = ["--run", runId, "--timeout", String(DEFAULT_WATCH_TIMEOUT_SEC), "--output", "json"];
    const watch =
      hooks.watch ??
      (async (watchArgs: string[]) => {
        const cliPath = hooks.cliPath ?? packageCliPath();
        const result = await execa(process.execPath, [cliPath, "watch", ...watchArgs], {
          cwd,
          reject: false,
        });
        return { stdout: result.stdout, exitCode: result.exitCode ?? 1 };
      });
    const result = await watch(args);
    if (result.exitCode !== 0) {
      empty(stdout);
      return;
    }
    const snapshot = result.stdout.trim();
    let reason = "unknown";
    try {
      reason = String((JSON.parse(snapshot) as { reason?: string }).reason ?? "unknown");
    } catch {
      empty(stdout);
      return;
    }
    const last =
      input.loop_count === 79
        ? "\nThis is the last automatic check. Say keep watching if the run is still going."
        : "";
    const followup_message = `[cw-watch] reason=${reason} run=${runId}
${snapshot}
Summarize this to the user. Do not start new fan-out work unless they asked. Do not sleep.${last}`;
    stdout.write(`${JSON.stringify({ followup_message })}\n`);
  } catch {
    empty(stdout);
  }
}
