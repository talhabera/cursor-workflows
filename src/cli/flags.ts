import { parseArgs } from "node:util";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_AGENTS,
  HARD_MAX_AGENTS,
  MAX_CONCURRENCY,
} from "../constants.js";
import { CliError } from "../errors.js";
import type { OutputFormat, WorkerBackendName, WorkflowSize } from "../types.js";
import { isOutputFormat, isWorkerBackendName, isWorkflowSize } from "../types.js";

export interface RunFlags {
  prompt: string | undefined;
  file: string | undefined;
  workflow: string | undefined;
  args: unknown;
  dryRun: boolean;
  yes: boolean;
  save: boolean;
  backend: WorkerBackendName;
  cwd: string;
  model: string | undefined;
  size: WorkflowSize;
  concurrency: number;
  maxAgents: number;
  output: OutputFormat;
  help: boolean;
}

export interface IdFlags {
  runId: string | undefined;
  output: OutputFormat;
  help: boolean;
  yes: boolean;
  name: string | undefined;
  user: boolean;
}

export function parseRunFlags(args: string[]): RunFlags {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      file: { type: "string" },
      workflow: { type: "string" },
      args: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      save: { type: "boolean", default: false },
      backend: { type: "string", default: "sdk" },
      cwd: { type: "string" },
      model: { type: "string" },
      size: { type: "string", default: "medium" },
      concurrency: { type: "string" },
      "max-agents": { type: "string" },
      output: { type: "string", default: "text" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const backendRaw = values.backend ?? "sdk";
  if (!isWorkerBackendName(backendRaw)) {
    throw new CliError(`unknown backend: ${backendRaw}`, {
      example: "cw run --backend sdk --file workflow.js --yes",
    });
  }
  const sizeRaw = values.size ?? "medium";
  if (!isWorkflowSize(sizeRaw)) {
    throw new CliError(`unknown size: ${sizeRaw}`, {
      example: "cw run --size medium \"your task\" --yes",
    });
  }
  const outputRaw = values.output ?? "text";
  if (!isOutputFormat(outputRaw)) {
    throw new CliError(`unknown output format: ${outputRaw}`, {
      example: "cw run --output json --file workflow.js --yes",
    });
  }

  return {
    prompt: positionals.length > 0 ? positionals.join(" ") : undefined,
    file: values.file,
    workflow: values.workflow,
    args: parseArgsJson(values.args),
    dryRun: values["dry-run"] === true,
    yes: values.yes === true,
    save: values.save === true,
    backend: backendRaw,
    cwd: values.cwd ?? process.cwd(),
    model: values.model,
    size: sizeRaw,
    concurrency: parseBoundedInt(
      values.concurrency,
      DEFAULT_CONCURRENCY,
      1,
      MAX_CONCURRENCY,
      "--concurrency",
    ),
    maxAgents: parseBoundedInt(
      values["max-agents"],
      DEFAULT_MAX_AGENTS,
      1,
      HARD_MAX_AGENTS,
      "--max-agents",
    ),
    output: outputRaw,
    help: values.help === true,
  };
}

export function parseIdFlags(args: string[]): IdFlags {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      run: { type: "string" },
      output: { type: "string", default: "text" },
      yes: { type: "boolean", default: false },
      name: { type: "string" },
      user: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const outputRaw = values.output ?? "text";
  if (!isOutputFormat(outputRaw)) {
    throw new CliError(`unknown output format: ${outputRaw}`, {
      example: "cw status --output json",
    });
  }
  return {
    runId: values.run,
    output: outputRaw,
    help: values.help === true,
    yes: values.yes === true,
    name: values.name,
    user: values.user === true,
  };
}

function parseArgsJson(raw: string | undefined): unknown {
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new CliError("--args must be valid JSON", {
      example: `cw run --workflow audit-routes --args '{"dir":"src/routes"}'`,
    });
  }
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  flag: string,
): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CliError(`${flag} must be an integer between ${min} and ${max}`, {
      example: `cw run ${flag} ${fallback} --file workflow.js --yes`,
    });
  }
  return value;
}
