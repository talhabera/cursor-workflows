import { readFile } from "node:fs/promises";
import { WATCH_POLL_MS } from "../constants.js";
import { parseWatchFlags } from "../cli/flags.js";
import { CliError } from "../errors.js";
import { decideNotify, reducePhaseMachine } from "../runtime/phase-machine.js";
import type { NotifyAction, PhaseCompletion, PhaseMachineState } from "../runtime/phase-machine.js";
import { readLastEvents } from "../store/events.js";
import { runFile } from "../store/paths.js";
import { listRuns, readRun, resolveRunId } from "../store/runs.js";
import { readWatchCursor, writeWatchCursor } from "../store/watch-cursor.js";
import type { RunRecord, WatchCursor, WatchReason } from "../types.js";
import { assertNever } from "../util/assert-never.js";
import { WATCH_HELP } from "./help.js";
import type { CommandIo } from "./run.js";

const RESULT_PREVIEW_MAX = 4000;

export interface WatchCommandHooks {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isPidAlive?: (pid: number) => boolean;
}

export interface WatchPayload {
  reason: WatchReason;
  run: RunRecord;
  phase: string | undefined;
  summary: {
    phase: string;
    ok: number;
    failed: number;
    cancelled: number;
    tokens: number;
    labels: string[];
    inFlight: Array<{ phase: string; label: string | undefined }>;
  };
  resultPreview: unknown;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidAliveFor(record: RunRecord, probe: (pid: number) => boolean): boolean {
  if (record.pid === undefined) {
    return record.status !== "running";
  }
  return probe(record.pid);
}

function inFlightSummary(state: PhaseMachineState): Array<{ phase: string; label: string | undefined }> {
  return state.inFlight.map((item) => ({ phase: item.phase, label: item.label }));
}

function summaryFrom(
  completion: PhaseCompletion | undefined,
  state: PhaseMachineState,
): WatchPayload["summary"] {
  const phase = completion?.phase ?? state.frontier ?? state.inFlight[0]?.phase ?? "(none)";
  return {
    phase,
    ok: completion?.ok ?? 0,
    failed: completion?.failed ?? 0,
    cancelled: completion?.cancelled ?? 0,
    tokens: completion?.tokens ?? 0,
    labels: completion?.labels ?? [],
    inFlight: inFlightSummary(state),
  };
}

function previewResult(value: unknown): unknown {
  const raw = JSON.stringify(value);
  if (raw === undefined) {
    return null;
  }
  if (raw.length <= RESULT_PREVIEW_MAX) {
    return value;
  }
  return raw.slice(0, RESULT_PREVIEW_MAX);
}

async function readResultPreview(cwd: string, runId: string): Promise<unknown> {
  try {
    const raw = await readFile(runFile(cwd, runId, "result.json"), "utf8");
    return previewResult(JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function consumeCursor(cursor: WatchCursor, action: NotifyAction): WatchCursor | undefined {
  switch (action.type) {
    case "phase_end":
      return { phaseEnds: [...cursor.phaseEnds, action.completion.phase], terminal: cursor.terminal };
    case "stale":
    case "terminal":
      return { ...cursor, terminal: true };
    case "heartbeat":
    case "wait":
    case "idle":
      return undefined;
    default:
      return assertNever(action);
  }
}

function formatText(payload: WatchPayload): string {
  const inflight =
    payload.summary.inFlight.length === 0
      ? "-"
      : payload.summary.inFlight
          .map((item) => `${item.phase}${item.label ? `:${item.label}` : ""}`)
          .join(", ");
  return [
    `reason: ${payload.reason}`,
    `id: ${payload.run.id}`,
    `status: ${payload.run.status}`,
    `phase: ${payload.phase ?? "-"}`,
    `ok: ${payload.summary.ok} failed: ${payload.summary.failed} cancelled: ${payload.summary.cancelled} tokens: ${payload.summary.tokens}`,
    `labels: ${payload.summary.labels.join(", ") || "-"}`,
    `in-flight: ${inflight}`,
  ].join("\n");
}

export async function selectWatchRun(
  cwd: string,
  hooks: WatchCommandHooks = {},
): Promise<string | undefined> {
  const probe = hooks.isPidAlive ?? isPidAlive;
  const runs = await listRuns(cwd);
  const interesting: RunRecord[] = [];
  for (const run of runs) {
    const record = await readRun(cwd, run.id);
    const events = await readLastEvents(runFile(cwd, run.id, "events.ndjson"), Number.MAX_SAFE_INTEGER);
    if (record.status === "awaiting_approval") {
      continue;
    }
    if (
      record.status === "completed" &&
      !events.some((event) => event.type === "agent_start" || event.type === "agent_end")
    ) {
      continue;
    }
    const cursor = await readWatchCursor(cwd, run.id);
    const state = reducePhaseMachine(events, record.status);
    const action = decideNotify({
      state,
      cursor,
      runStatus: record.status,
      pidAlive: pidAliveFor(record, probe),
      timeoutElapsed: false,
    });
    if (action.type !== "idle") {
      interesting.push(run);
    }
  }
  const active = interesting.find(
    (run) =>
      run.status === "pending" ||
      run.status === "planning" ||
      run.status === "running",
  );
  return (active ?? interesting[0])?.id;
}

async function buildPayload(
  cwd: string,
  record: RunRecord,
  state: PhaseMachineState,
  action: NotifyAction,
): Promise<WatchPayload> {
  switch (action.type) {
    case "phase_end":
      return {
        reason: "phase_end",
        run: record,
        phase: action.completion.phase,
        summary: summaryFrom(action.completion, state),
        resultPreview: null,
      };
    case "heartbeat":
      return {
        reason: "heartbeat",
        run: record,
        phase: state.frontier,
        summary: summaryFrom(undefined, state),
        resultPreview: null,
      };
    case "terminal":
      return {
        reason: "terminal",
        run: record,
        phase: state.completed.at(-1)?.phase,
        summary: summaryFrom(state.completed.at(-1), state),
        resultPreview: await readResultPreview(cwd, record.id),
      };
    case "stale":
      return {
        reason: "stale",
        run: record,
        phase: state.frontier,
        summary: summaryFrom(undefined, state),
        resultPreview: null,
      };
    case "wait":
    case "idle":
      throw new Error(`cannot serialize ${action.type}`);
    default:
      return assertNever(action);
  }
}

export async function watchCommand(
  argv: string[],
  io: CommandIo = process,
  cwd: string = process.cwd(),
  hooks: WatchCommandHooks = {},
): Promise<number> {
  const flags = parseWatchFlags(argv);
  if (flags.help) {
    io.stdout.write(`${WATCH_HELP}\n`);
    return 0;
  }
  let runId: string;
  try {
    runId = await resolveRunId(cwd, flags.runId);
  } catch {
    throw new CliError("no runs found", {
      example: "cw watch --run <id>",
    });
  }
  const probe = hooks.isPidAlive ?? isPidAlive;
  const now = hooks.now ?? Date.now;
  const sleep =
    hooks.sleep ??
    (async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  const started = now();
  const deadline = flags.timeout === 0 ? Number.POSITIVE_INFINITY : started + flags.timeout * 1000;

  for (;;) {
    const record = await readRun(cwd, runId);
    const events = await readLastEvents(runFile(cwd, runId, "events.ndjson"), Number.MAX_SAFE_INTEGER);
    const cursor = await readWatchCursor(cwd, runId);
    const state = reducePhaseMachine(events, record.status);
    const timeoutElapsed = now() >= deadline && flags.timeout !== 0;
    const action = decideNotify({
      state,
      cursor,
      runStatus: record.status,
      pidAlive: pidAliveFor(record, probe),
      timeoutElapsed,
    });
    if (action.type === "wait") {
      if (now() >= deadline && flags.timeout !== 0) {
        continue;
      }
      await sleep(WATCH_POLL_MS);
      continue;
    }
    if (action.type === "idle") {
      const payload: WatchPayload = {
        reason: "terminal",
        run: record,
        phase: state.completed.at(-1)?.phase,
        summary: summaryFrom(state.completed.at(-1), state),
        resultPreview: await readResultPreview(cwd, runId),
      };
      if (flags.output === "json") {
        io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        io.stdout.write(`${formatText(payload)}\n`);
      }
      return 0;
    }
    const payload = await buildPayload(cwd, record, state, action);
    const nextCursor = consumeCursor(cursor, action);
    if (nextCursor) {
      await writeWatchCursor(cwd, runId, nextCursor);
    }
    if (flags.output === "json") {
      io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      io.stdout.write(`${formatText(payload)}\n`);
    }
    return 0;
  }
}
