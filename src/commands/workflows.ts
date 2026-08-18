import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { WORKFLOWS_HELP } from "./help.js";
import { parseIdFlags } from "../cli/flags.js";
import { CliError } from "../errors.js";
import { readRun, resolveRunId } from "../store/runs.js";
import { listSavedWorkflows, saveWorkflow } from "../store/workflows.js";
import type { CommandIo } from "./run.js";

export async function workflowsCommand(
  argv: string[],
  io: CommandIo = process,
  cwd: string = process.cwd(),
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "-h" || subcommand === "--help") {
    io.stdout.write(`${WORKFLOWS_HELP}\n`);
    return 0;
  }
  switch (subcommand) {
    case "list":
      return listWorkflows(rest, io, cwd);
    case "save":
      return saveFromRun(rest, io, cwd);
    default:
      throw new CliError(`unknown workflows subcommand: ${subcommand}`, {
        example: "cw workflows list",
      });
  }
}

async function listWorkflows(
  argv: string[],
  io: CommandIo,
  cwd: string,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      output: { type: "string", default: "text" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout.write(`${WORKFLOWS_HELP}\n`);
    return 0;
  }
  const items = await listSavedWorkflows(cwd);
  if (values.output === "json") {
    io.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return 0;
  }
  if (items.length === 0) {
    io.stdout.write("no saved workflows\n");
    return 0;
  }
  for (const item of items) {
    const description = item.meta.description ? ` — ${item.meta.description}` : "";
    io.stdout.write(`${item.name} (${item.scope})${description}\n`);
  }
  return 0;
}

async function saveFromRun(argv: string[], io: CommandIo, cwd: string): Promise<number> {
  const flags = parseIdFlags(argv);
  if (flags.help) {
    io.stdout.write(`${WORKFLOWS_HELP}\n`);
    return 0;
  }
  let runId: string;
  try {
    runId = await resolveRunId(cwd, flags.runId);
  } catch {
    throw new CliError("no runs found", {
      example: "cw workflows save --run <id> --name audit-routes",
    });
  }
  const record = await readRun(cwd, runId);
  const source = await readFile(record.workflowPath, "utf8");
  const saved = await saveWorkflow(cwd, source, {
    name: flags.name,
    scope: flags.user ? "user" : "project",
  });
  io.stdout.write(`saved: ${saved}\n`);
  return 0;
}
