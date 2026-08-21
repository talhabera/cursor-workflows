import { STOP_HELP } from "./help.js";
import { parseIdFlags } from "../cli/flags.js";
import { CliError } from "../errors.js";
import { Journal } from "../runtime/journal.js";
import { runFile } from "../store/paths.js";
import { readRun, resolveRunId, updateRun } from "../store/runs.js";
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

  const selective = flags.phase !== undefined || flags.label !== undefined;
  if (!selective) {
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

  const current = await readRun(cwd, runId);
  const cancelPhases = [...(current.cancelPhases ?? [])];
  const cancelLabels = [...(current.cancelLabels ?? [])];
  if (flags.phase && !cancelPhases.includes(flags.phase)) {
    cancelPhases.push(flags.phase);
  }
  if (flags.label && !cancelLabels.includes(flags.label)) {
    cancelLabels.push(flags.label);
  }
  await updateRun(cwd, runId, { cancelPhases, cancelLabels });

  const journal = await Journal.load(runFile(cwd, runId, "journal.json"));
  const running = journal.toJSON().filter((entry) => entry.status === "running");
  const matched = running.some(
    (entry) =>
      (flags.phase !== undefined && entry.phase === flags.phase) ||
      (flags.label !== undefined && entry.label === flags.label),
  );
  if (!matched) {
    io.stdout.write("no matching in-flight agents\n");
    return 0;
  }
  io.stdout.write(
    `cancel requested: ${runId}${flags.phase ? ` phase=${flags.phase}` : ""}${flags.label ? ` label=${flags.label}` : ""}\n`,
  );
  return 0;
}
