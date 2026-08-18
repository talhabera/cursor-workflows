import { createHash } from "node:crypto";
import vm from "node:vm";
import { LARGE_RUN_AGENT_WARNING } from "../constants.js";
import { WorkflowLimitError } from "../errors.js";
import { createWorktree } from "../isolation/worktree.js";
import type { ProgressSink } from "../progress.js";
import type {
  AgentCallOptions,
  IsolationMode,
  JournalEntry,
  RunEvent,
  ToolPreset,
  WorkerBackend,
  WorkflowMeta,
} from "../types.js";
import { assertNever } from "../util/assert-never.js";
import { Journal } from "./journal.js";
import { createSandboxGlobals, extractMeta, transformWorkflowSource } from "./sandbox.js";
import { validateJsonSchema } from "./schema.js";
import { Semaphore } from "./semaphore.js";

export interface ExecuteWorkflowOptions {
  source: string;
  args: unknown;
  cwd: string;
  runId: string;
  backend: WorkerBackend;
  journal: Journal;
  model: string;
  concurrency: number;
  maxAgents: number;
  signal: AbortSignal;
  progress: ProgressSink;
  persistJournal?: () => Promise<void>;
  shouldStop?: () => Promise<boolean> | boolean;
  shouldCancel?: (call: { phase?: string; label?: string }) => Promise<boolean> | boolean;
  now?: () => string;
}

export interface ExecuteWorkflowResult {
  result: unknown;
  meta: WorkflowMeta;
  agentCount: number;
  tokens: number;
}

type AgentFn = (prompt: string, options?: AgentCallOptions) => Promise<unknown>;
type StageFn = (item: unknown) => Promise<unknown> | unknown;
type PipelineFn = (items: unknown[], ...stages: StageFn[]) => Promise<unknown[]>;
type ParallelFn = (thunks: Array<() => Promise<unknown> | unknown>) => Promise<unknown[]>;

export async function executeWorkflow(
  options: ExecuteWorkflowOptions,
): Promise<ExecuteWorkflowResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const transformed = transformWorkflowSource(options.source);
  const meta = extractMeta(options.source);
  const semaphore = new Semaphore(options.concurrency);
  const keyCounts = new Map<string, number>();
  let callIndex = 0;
  let warnedLarge = false;
  let tokens = 0;
  const worktreeIndex = { value: 0 };

  const emit = (event: RunEvent): Promise<void> => options.progress.emit(event);

  const agent: AgentFn = async (prompt, callOptions = {}) => {
    if (options.signal.aborted || (await options.shouldStop?.())) {
      throw new Error("workflow stopped");
    }
    if (callIndex >= options.maxAgents) {
      throw new WorkflowLimitError(
        `workflow exceeded max agents (${options.maxAgents}). Raise --max-agents (hard cap 1000) or shrink the script`,
      );
    }

    const tools = normalizeTools(callOptions.tools);
    const isolation = normalizeIsolation(callOptions.isolation);
    const key = nextKey(callOptions.label, prompt, keyCounts);
    const existing = options.journal.completed(key);
    if (existing) {
      callIndex += 1;
      tokens += existing.tokens;
      return existing.result;
    }

    if (await options.shouldCancel?.({ phase: callOptions.phase, label: callOptions.label })) {
      callIndex += 1;
      const cancelledIndex = callIndex;
      const cancelledEntry: JournalEntry = {
        callIndex: cancelledIndex,
        key,
        prompt,
        label: callOptions.label,
        phase: callOptions.phase,
        status: "completed",
        result: null,
        tokens: 0,
        workerId: undefined,
      };
      options.journal.upsert(cancelledEntry);
      await options.persistJournal?.();
      await emit({
        type: "agent_end",
        at: now(),
        callIndex: cancelledIndex,
        key,
        ok: false,
        tokens: 0,
        phase: callOptions.phase,
      });
      return null;
    }

    callIndex += 1;
    const thisIndex = callIndex;
    if (!warnedLarge && thisIndex === LARGE_RUN_AGENT_WARNING) {
      warnedLarge = true;
      await emit({
        type: "warning",
        at: now(),
        message: `Large workflow: ${LARGE_RUN_AGENT_WARNING} agents scheduled. Inspect with cw status --run ${options.runId}`,
      });
    }

    const running: JournalEntry = {
      callIndex: thisIndex,
      key,
      prompt,
      label: callOptions.label,
      phase: callOptions.phase,
      status: "running",
      result: null,
      tokens: 0,
      workerId: undefined,
    };
    options.journal.upsert(running);
    await options.persistJournal?.();

    await emit({
      type: "agent_start",
      at: now(),
      callIndex: thisIndex,
      key,
      label: callOptions.label,
      phase: callOptions.phase,
    });

    await semaphore.acquire();
    let cwd = callOptions.cwd ?? options.cwd;
    const callAbort = new AbortController();
    if (options.signal.aborted) {
      callAbort.abort();
    }
    const onParentAbort = (): void => callAbort.abort();
    options.signal.addEventListener("abort", onParentAbort, { once: true });
    const tick = async (): Promise<void> => {
      if (options.signal.aborted || (await options.shouldStop?.())) {
        callAbort.abort();
        return;
      }
      if (await options.shouldCancel?.({ phase: callOptions.phase, label: callOptions.label })) {
        callAbort.abort();
      }
    };
    const poll = setInterval(() => {
      void tick();
    }, 200);
    try {
      if (isolation === "worktree") {
        worktreeIndex.value += 1;
        cwd = await createWorktree({
          repoRoot: options.cwd,
          runId: options.runId,
          label: callOptions.label ?? key,
          index: worktreeIndex.value,
        });
      }

      const workerResult = await options.backend.start({
        prompt,
        cwd,
        model: callOptions.model ?? options.model,
        tools,
        schema: callOptions.schema,
        label: callOptions.label,
        phase: callOptions.phase,
        isolation,
        signal: callAbort.signal,
      });

      if (callAbort.signal.aborted) {
        if (options.signal.aborted || (await options.shouldStop?.())) {
          throw new Error("workflow stopped");
        }
        const cancelledEntry: JournalEntry = {
          ...running,
          status: "completed",
          result: null,
          tokens: 0,
          workerId: undefined,
        };
        options.journal.upsert(cancelledEntry);
        await options.persistJournal?.();
        await emit({
          type: "agent_end",
          at: now(),
          callIndex: thisIndex,
          key,
          ok: false,
          tokens: 0,
          phase: callOptions.phase,
        });
        return null;
      }

      let result: unknown = workerResult.result;
      if (workerResult.status !== "finished") {
        result = null;
      } else if (callOptions.schema) {
        const checked = validateJsonSchema(callOptions.schema, result);
        if (!checked.ok) {
          result = null;
        }
      }

      const completed: JournalEntry = {
        ...running,
        status: "completed",
        result,
        tokens: workerResult.tokens,
        workerId: workerResult.id,
      };
      options.journal.upsert(completed);
      await options.persistJournal?.();
      tokens += workerResult.tokens;
      await emit({
        type: "agent_end",
        at: now(),
        callIndex: thisIndex,
        key,
        ok: result !== null,
        tokens: workerResult.tokens,
        phase: callOptions.phase,
      });
      return result;
    } catch (error) {
      if (options.signal.aborted || (error instanceof Error && error.message === "workflow stopped")) {
        throw error;
      }
      const completed: JournalEntry = {
        ...running,
        status: "completed",
        result: null,
        tokens: 0,
        workerId: undefined,
      };
      options.journal.upsert(completed);
      await options.persistJournal?.();
      await emit({
        type: "agent_end",
        at: now(),
        callIndex: thisIndex,
        key,
        ok: false,
        tokens: 0,
        phase: callOptions.phase,
      });
      return null;
    } finally {
      clearInterval(poll);
      options.signal.removeEventListener("abort", onParentAbort);
      semaphore.release();
    }
  };

  const pipeline: PipelineFn = async (items, ...stages) => {
    if (!Array.isArray(items)) {
      throw new Error("pipeline(items, ...stages) expects an array as the first argument");
    }
    const results: unknown[] = new Array(items.length);
    await Promise.all(
      items.map(async (item, index) => {
        let current: unknown = item;
        try {
          for (const stage of stages) {
            current = await stage(current);
          }
          results[index] = current;
        } catch {
          results[index] = null;
        }
      }),
    );
    return results;
  };

  const parallel: ParallelFn = async (thunks) =>
    Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk();
        } catch {
          return null;
        }
      }),
    );

  const { Math: sandboxMath, Date: sandboxDate } = createSandboxGlobals();
  let resolveRun: (value: unknown) => void = () => undefined;
  let rejectRun: (error: unknown) => void = () => undefined;
  const completion = new Promise<unknown>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });

  const sandbox = {
    agent,
    pipeline,
    parallel,
    args: options.args,
    Math: sandboxMath,
    Date: sandboxDate,
    JSON,
    Array,
    Object,
    Map,
    Set,
    Promise,
    Error,
    TypeError,
    RangeError,
    Boolean,
    Number,
    String,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    undefined,
    Infinity,
    NaN,
    console: {
      log: (...parts: unknown[]) => process.stderr.write(`${parts.map(String).join(" ")}\n`),
      warn: (...parts: unknown[]) => process.stderr.write(`${parts.map(String).join(" ")}\n`),
      error: (...parts: unknown[]) => process.stderr.write(`${parts.map(String).join(" ")}\n`),
    },
    __resolve: (value: unknown) => {
      Promise.resolve(value).then(resolveRun, rejectRun);
    },
  };

  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  const script = new vm.Script(transformed, { filename: "workflow.js" });
  script.runInContext(context);
  const result = await completion;

  return {
    result,
    meta,
    agentCount: callIndex,
    tokens,
  };
}

function nextKey(
  label: string | undefined,
  prompt: string,
  keyCounts: Map<string, number>,
): string {
  const base =
    label ??
    `anon:${createHash("sha256").update(prompt).digest("hex").slice(0, 12)}`;
  const seen = keyCounts.get(base) ?? 0;
  keyCounts.set(base, seen + 1);
  return seen === 0 ? base : `${base}#${seen + 1}`;
}

function normalizeTools(value: ToolPreset | undefined): ToolPreset {
  if (value === undefined) {
    return "read";
  }
  switch (value) {
    case "read":
    case "write":
    case "full":
      return value;
    default:
      return assertNever(value);
  }
}

function normalizeIsolation(value: IsolationMode | undefined): IsolationMode {
  if (value === undefined) {
    return "cwd";
  }
  switch (value) {
    case "cwd":
    case "worktree":
      return value;
    default:
      return assertNever(value);
  }
}
