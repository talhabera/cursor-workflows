import { parseArgs } from "node:util";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_AGENTS,
  DEFAULT_WATCH_TIMEOUT_SEC,
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
  detach: boolean;
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
  phase: string | undefined;
  label: string | undefined;
}

export interface WatchFlags {
  runId: string | undefined;
  timeout: number;
  output: OutputFormat;
  help: boolean;
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
      detach: { type: "boolean", default: false },
      backend: { type: "string", default: "cli" },
      cwd: { type: "string" },
      model: { type: "string" },
      size: { type: "string", default: "medium" },
      concurrency: { type: "string" },
      "max-agents": { type: "string" },
      output: { type: "string", default: "text" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const backendRaw = values.backend ?? "cli";
  if (!isWorkerBackendName(backendRaw)) {
    throw new CliError(`unknown backend: ${backendRaw}`, {
      example: "cw run --backend cli --file workflow.js --yes",
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
    detach: values.detach === true,
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
      phase: { type: "string" },
      label: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const outputRaw = values.output ?? "text";
  if (!isOutputFormat(outputRaw)) {
    throw new CliError(`unknown output format: ${outputRaw}`, {
      example: "cw status --output json",
    });
  }
  assertNonEmptySelector("--phase", values.phase);
  assertNonEmptySelector("--label", values.label);
  return {
    runId: values.run,
    output: outputRaw,
    help: values.help === true,
    yes: values.yes === true,
    name: values.name,
    user: values.user === true,
    phase: values.phase,
    label: values.label,
  };
}

export function parseWatchFlags(args: string[]): WatchFlags {
  const normalizedArgs = [...args];
  for (let i = 0; i < normalizedArgs.length - 1; i++) {
    if (normalizedArgs[i] === "--timeout" && normalizedArgs[i + 1]?.startsWith("-")) {
      normalizedArgs[i] = `--timeout=${normalizedArgs[i + 1]}`;
      normalizedArgs.splice(i + 1, 1);
      break;
    }
  }
  const { values } = parseArgs({
    args: normalizedArgs,
    allowPositionals: true,
    options: {
      run: { type: "string" },
      timeout: { type: "string" },
      output: { type: "string", default: "text" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const outputRaw = values.output ?? "text";
  if (!isOutputFormat(outputRaw)) {
    throw new CliError(`unknown output format: ${outputRaw}`, {
      example: "cw watch --output json",
    });
  }
  let timeout = DEFAULT_WATCH_TIMEOUT_SEC;
  if (values.timeout !== undefined) {
    const value = Number(values.timeout);
    if (!Number.isInteger(value) || value < 0 || value > 86400) {
      throw new CliError("--timeout must be an integer between 0 and 86400", {
        example: "cw watch --timeout 300 --run <id>",
      });
    }
    timeout = value;
  }
  return {
    runId: values.run,
    timeout,
    output: outputRaw,
    help: values.help === true,
  };
}

function assertNonEmptySelector(flag: "--phase" | "--label", value: string | undefined): void {
  if (value !== undefined && value.trim() === "") {
    throw new CliError(`${flag} must not be empty`, {
      example: "cw stop --run <id> --phase verify",
    });
  }
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
