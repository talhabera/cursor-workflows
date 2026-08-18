import { STATUS_HELP } from "./help.js";
import { parseIdFlags } from "../cli/flags.js";
import { CliError } from "../errors.js";
import { Journal } from "../runtime/journal.js";
import { readLastEvents } from "../store/events.js";
import { runFile } from "../store/paths.js";
import { readRun, resolveRunId } from "../store/runs.js";
import type { CommandIo } from "./run.js";

export async function statusCommand(
  argv: string[],
  io: CommandIo = process,
  cwd: string = process.cwd(),
): Promise<number> {
  const flags = parseIdFlags(argv);
  if (flags.help) {
    io.stdout.write(`${STATUS_HELP}\n`);
    return 0;
  }
  let runId: string;
  try {
    runId = await resolveRunId(cwd, flags.runId);
  } catch {
    throw new CliError("no runs found", {
      example: "cw run --file examples/audit-routes.js --yes",
    });
  }
  const record = await readRun(cwd, runId);
  const journal = await Journal.load(runFile(cwd, runId, "journal.json"));
  const events = await readLastEvents(runFile(cwd, runId, "events.ndjson"), 200);
  if (flags.output === "json") {
    io.stdout.write(`${JSON.stringify({ run: record, journal: journal.toJSON(), events }, null, 2)}\n`);
    return 0;
  }
  const lines = [
    `id: ${record.id}`,
    `status: ${record.status}`,
    `backend: ${record.backend}`,
    `model: ${record.model}`,
    `agents: ${record.agentCount}`,
    `tokens: ${record.tokens}`,
    `workflow: ${record.workflowPath}`,
    record.error ? `error: ${record.error}` : undefined,
  ];
  for (const entry of journal.toJSON()) {
    lines.push(`${entry.phase ?? "-"} ${entry.label ?? entry.key} ${entry.status}`);
  }
  io.stdout.write(`${lines.filter(Boolean).join("\n")}\n`);
  return 0;
}
