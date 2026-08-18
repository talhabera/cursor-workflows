import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MODEL } from "../constants.js";
import { CliError } from "../errors.js";
import { planWorkflow } from "../planner/generate.js";
import { createProgressSink } from "../progress.js";
import { executeWorkflow } from "../runtime/execute.js";
import { Journal } from "../runtime/journal.js";
import { parseRunFlags } from "../cli/flags.js";
import { RUN_HELP } from "./help.js";
import { runFile } from "../store/paths.js";
import { newRunId, readRun, updateRun, writeResult, writeRun, writeWorkflowSource } from "../store/runs.js";
import { loadWorkflowByName, saveWorkflow } from "../store/workflows.js";
import type { RunRecord } from "../types.js";
import { createWorkerBackend, requireApiKey } from "../workers/create.js";

export interface CommandIo {
  stdout: { write(chunk: string): unknown; isTTY?: boolean };
  stderr: { write(chunk: string): unknown; isTTY?: boolean };
}

export async function runCommand(argv: string[], io: CommandIo = process): Promise<number> {
  const flags = parseRunFlags(argv);
  if (flags.help) {
    io.stdout.write(`${RUN_HELP}\n`);
    return 0;
  }

  const cwd = path.resolve(flags.cwd);
  const sources = [flags.prompt, flags.file, flags.workflow].filter(Boolean);
  if (sources.length === 0) {
    throw new CliError("provide a prompt, --file, or --workflow", {
      example: "cw run --file examples/audit-routes.js --yes",
    });
  }
  if (Boolean(flags.file) && Boolean(flags.workflow)) {
    throw new CliError("use either --file or --workflow, not both", {
      example: "cw run --file .cursor/workflows/audit-routes.js",
    });
  }

  const runId = newRunId();
  const createdAt = new Date().toISOString();
  const record: RunRecord = {
    id: runId,
    status: "pending",
    cwd,
    backend: flags.backend,
    model: flags.model ?? DEFAULT_MODEL,
    createdAt,
    updatedAt: createdAt,
    pid: process.pid,
    stopRequested: false,
    cancelPhases: [],
    cancelLabels: [],
    workflowPath: runFile(cwd, runId, "workflow.js"),
    prompt: flags.prompt,
    args: flags.args,
    size: flags.size,
    concurrency: flags.concurrency,
    maxAgents: flags.maxAgents,
    error: undefined,
    agentCount: 0,
    tokens: 0,
  };
  await writeRun(cwd, record);

  const generated = !flags.file && !flags.workflow;
  let source: string;
  try {
    if (flags.file) {
      source = await readFile(path.resolve(cwd, flags.file), "utf8");
    } else if (flags.workflow) {
      source = await loadWorkflowByName(cwd, flags.workflow);
    } else {
      requireApiKey(flags.backend);
      if (!flags.prompt) {
        throw new CliError("planner requires a prompt", {
          example: 'cw run "audit src/routes for missing auth" --yes',
        });
      }
      await updateRun(cwd, runId, { status: "planning" });
      source = await planWorkflow({
        task: flags.prompt,
        cwd,
        model: flags.model,
        size: flags.size,
        backend: createWorkerBackend(flags.backend),
      });
    }
  } catch (error) {
    await updateRun(cwd, runId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const workflowPath = await writeWorkflowSource(cwd, runId, source);

  if (generated && !flags.yes && !flags.dryRun) {
    await updateRun(cwd, runId, { status: "awaiting_approval", workflowPath });
    io.stdout.write(`${source.trim()}\n`);
    throw new CliError("planner wrote a workflow; pass --yes to execute", {
      example: `cw run --file ${workflowPath} --yes`,
    });
  }

  if (flags.dryRun) {
    await updateRun(cwd, runId, { status: "completed", workflowPath });
    io.stdout.write(`${source.trim()}\n`);
    if (flags.output === "json") {
      io.stderr.write(`${JSON.stringify({ runId, dryRun: true, workflowPath })}\n`);
    } else {
      io.stderr.write(`run: ${runId}\nworkflow: ${workflowPath}\n`);
    }
    return 0;
  }

  if (flags.backend !== "fake") {
    requireApiKey(flags.backend);
  }

  return executeExistingRun({
    cwd,
    runId,
    source,
    args: flags.args,
    backendName: flags.backend,
    model: flags.model ?? DEFAULT_MODEL,
    concurrency: flags.concurrency,
    maxAgents: flags.maxAgents,
    output: flags.output,
    save: flags.save,
    io,
  });
}

export async function executeExistingRun(options: {
  cwd: string;
  runId: string;
  source: string;
  args: unknown;
  backendName: RunRecord["backend"];
  model: string;
  concurrency: number;
  maxAgents: number;
  output: "text" | "json";
  save: boolean;
  io: CommandIo;
}): Promise<number> {
  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
    void updateRun(options.cwd, options.runId, { stopRequested: true, status: "stopped" });
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  await updateRun(options.cwd, options.runId, {
    status: "running",
    pid: process.pid,
    stopRequested: false,
  });

  const journalPath = runFile(options.cwd, options.runId, "journal.json");
  const journal = await Journal.load(journalPath);
  const progress = createProgressSink({
    eventsPath: runFile(options.cwd, options.runId, "events.ndjson"),
    format: options.output,
    stderr: options.io.stderr,
  });

  try {
    const executed = await executeWorkflow({
      source: options.source,
      args: options.args,
      cwd: options.cwd,
      runId: options.runId,
      backend: createWorkerBackend(options.backendName),
      journal,
      model: options.model,
      concurrency: options.concurrency,
      maxAgents: options.maxAgents,
      signal: controller.signal,
      progress,
      persistJournal: () => journal.save(journalPath),
      shouldStop: async () => {
        try {
          const current = await readRun(options.cwd, options.runId);
          return current.stopRequested;
        } catch {
          return false;
        }
      },
    });

    await journal.save(journalPath);
    await writeResult(options.cwd, options.runId, executed.result);
    await updateRun(options.cwd, options.runId, {
      status: "completed",
      agentCount: executed.agentCount,
      tokens: executed.tokens,
      error: undefined,
    });

    if (options.save) {
      const saved = await saveWorkflow(options.cwd, options.source, {
        name: executed.meta.name,
      });
      options.io.stderr.write(`saved: ${saved}\n`);
    }

    if (options.output === "json") {
      options.io.stdout.write(
        `${JSON.stringify({ runId: options.runId, result: executed.result, meta: executed.meta }, null, 2)}\n`,
      );
    } else {
      options.io.stderr.write(
        `\nrun: ${options.runId}\nagents: ${executed.agentCount} · tokens: ${executed.tokens}\n`,
      );
      options.io.stdout.write(`${stringifyResult(executed.result)}\n`);
    }
    return 0;
  } catch (error) {
    await journal.save(journalPath);
    const stopped = controller.signal.aborted;
    await updateRun(options.cwd, options.runId, {
      status: stopped ? "stopped" : "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    if (stopped) {
      throw new CliError("workflow stopped", {
        exitCode: 130,
        example: `cw resume --run ${options.runId}`,
      });
    }
    throw error;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
    if (options.output === "text" && options.io.stderr.isTTY) {
      options.io.stderr.write("\n");
    }
  }
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  return JSON.stringify(result, null, 2);
}
