import { readFile } from "node:fs/promises";
import { RESUME_HELP } from "./help.js";
import { parseIdFlags } from "../cli/flags.js";
import { CliError } from "../errors.js";
import { readRun, resolveRunId } from "../store/runs.js";
import { executeExistingRun, type CommandIo } from "./run.js";

export async function resumeCommand(
  argv: string[],
  io: CommandIo = process,
  cwd: string = process.cwd(),
): Promise<number> {
  const flags = parseIdFlags(argv);
  if (flags.help) {
    io.stdout.write(`${RESUME_HELP}\n`);
    return 0;
  }
  let runId: string;
  try {
    runId = await resolveRunId(cwd, flags.runId);
  } catch {
    throw new CliError("no runs found", { example: "cw resume --run <id>" });
  }
  const record = await readRun(cwd, runId);
  const source = await readFile(record.workflowPath, "utf8");
  return executeExistingRun({
    cwd,
    runId,
    source,
    args: record.args,
    backendName: record.backend,
    model: record.model,
    concurrency: record.concurrency,
    maxAgents: record.maxAgents,
    output: flags.output,
    save: false,
    io,
  });
}
