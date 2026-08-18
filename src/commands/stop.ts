import { STOP_HELP } from "./help.js";
import { parseIdFlags } from "../cli/flags.js";
import { CliError } from "../errors.js";
import { resolveRunId, updateRun } from "../store/runs.js";
import type { CommandIo } from "./run.js";

export async function stopCommand(
  argv: string[],
  io: CommandIo = process,
  cwd: string = process.cwd(),
): Promise<number> {
  const flags = parseIdFlags(argv);
  if (flags.help) {
    io.stdout.write(`${STOP_HELP}\n`);
    return 0;
  }
  let runId: string;
  try {
    runId = await resolveRunId(cwd, flags.runId);
  } catch {
    throw new CliError("no runs found", { example: "cw stop --run <id>" });
  }
  const record = await updateRun(cwd, runId, { stopRequested: true });
  if (record.pid) {
    try {
      process.kill(record.pid, "SIGTERM");
    } catch {
      // process may already have exited
    }
  }
  io.stdout.write(`stop requested: ${runId}\n`);
  return 0;
}
