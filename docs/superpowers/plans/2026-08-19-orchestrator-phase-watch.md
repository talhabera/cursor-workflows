# Orchestrator Phase Watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After `cw` / `cw chat` detaches a workflow, the orchestrator posts a phase summary when a phase ends and a short heartbeat every 5 minutes, without the user asking.

**Architecture:** A pure phase machine derives completions from existing `events.ndjson`. `cw watch` waits until the next unconsumed phase-end, terminal, stale pid, or timeout. A bundled plugin `stop` hook calls `cw watch` after each orchestrator turn and returns `followup_message`. The orchestrator skill rewrites `[cw-watch]` payloads into user-facing summaries. No MCP. No `sleep 300` in the skill.

**Tech Stack:** Node 22.13+, TypeScript ESM, vitest, existing `cw` run store (`run.json`, `events.ndjson`).

## Global Constraints

- Node `>=22.13`; package is ESM (`"type": "module"`).
- No live `agent` and no `CURSOR_API_KEY` in unit tests.
- Do not add an MCP server.
- Workflow JS never reads user stdin. `cw status` must not start blocking or writing watch cursors.
- `cw watch` exit 0 on successful wait (including heartbeat/terminal/stale); exit 1 only for CLI/config (no runs, bad flags).
- Default watch timeout is `300` seconds. Hook watch timeout is always `300`. Hook process timeout is `330`. `loop_limit` is `80`.
- Unlabeled `agent()` calls group as `(unlabeled)`.
- Sequential `agent()` calls that share a phase must not emit a phase-end between them.
- One notify reason per `cw watch` invocation: unconsumed `phase_end`, then `stale`, then `terminal`; `heartbeat` only when still waiting.
- Heartbeat must not write `watch-cursor.json`.
- Hook fail-open: any error prints `{}\n`.
- Tests: `npx vitest run <file>`.
- Exhaustive `switch` on unions with a `never` default.
- Imports at top of file only.

## File map

| File | Responsibility |
| --- | --- |
| `src/types.ts` | `WatchCursor`, `WatchReason` |
| `src/constants.ts` | `DEFAULT_WATCH_TIMEOUT_SEC`, `WATCH_POLL_MS`, `UNLABELED_PHASE` |
| `src/runtime/phase-machine.ts` | Reduce events → completions; `decideNotify` |
| `src/store/watch-cursor.ts` | Read/write `watch-cursor.json` |
| `src/cli/flags.ts` | `parseWatchFlags` |
| `src/commands/help.ts` | `WATCH_HELP`; root help lists `watch` |
| `src/commands/watch.ts` | `cw watch` + `selectWatchRun` |
| `src/hooks/orchestrator-stop.ts` | Fail-open stop-hook logic |
| `src/cli.ts` | Dispatch `watch` |
| `plugin/.cursor-plugin/plugin.json` | `hooks` path |
| `plugin/hooks/hooks.json` | `stop` hook config |
| `plugin/hooks/orchestrator-stop.js` | Stdin wrapper around compiled hook |
| `plugin/skills/cw-orchestrator/SKILL.md` | Watch protocol |
| `README.md` | Auto summaries in `cw` chat |

---

### Task 1: Phase machine

**Files:**
- Create: `src/runtime/phase-machine.ts`
- Create: `src/runtime/phase-machine.test.ts`
- Modify: `src/types.ts`
- Modify: `src/constants.ts`

**Interfaces:**
- Consumes: `RunEvent`, `RunStatus` from `src/types.ts`
- Produces: `WatchCursor`, `WatchReason`; `UNLABELED_PHASE`; `normalizePhase`; `reducePhaseMachine`; `decideNotify`; `PhaseCompletion`; `PhaseMachineState`; `NotifyAction`

- [ ] **Step 1: Write the failing test**

Add to `src/types.ts` after `RunRecord`:

```typescript
export type WatchReason = "phase_end" | "heartbeat" | "terminal" | "stale";

export interface WatchCursor {
  phaseEnds: string[];
  terminal: boolean;
}
```

Add to `src/constants.ts`:

```typescript
export const UNLABELED_PHASE = "(unlabeled)";
export const DEFAULT_WATCH_TIMEOUT_SEC = 300;
export const WATCH_POLL_MS = 200;
```

Create `src/runtime/phase-machine.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { UNLABELED_PHASE } from "../constants.js";
import type { RunEvent, RunStatus, WatchCursor } from "../types.js";
import { decideNotify, normalizePhase, reducePhaseMachine } from "./phase-machine.js";

function start(
  callIndex: number,
  phase: string | undefined,
  label?: string,
): RunEvent {
  return {
    type: "agent_start",
    at: "t",
    callIndex,
    key: `k${callIndex}`,
    label,
    phase,
  };
}

function end(callIndex: number, phase: string | undefined, ok = true, tokens = 1): RunEvent {
  return { type: "agent_end", at: "t", callIndex, key: `k${callIndex}`, ok, tokens, phase };
}

const emptyCursor: WatchCursor = { phaseEnds: [], terminal: false };

describe("normalizePhase", () => {
  it("maps missing and empty phase to (unlabeled)", () => {
    expect(normalizePhase(undefined)).toBe(UNLABELED_PHASE);
    expect(normalizePhase("")).toBe(UNLABELED_PHASE);
    expect(normalizePhase("audit")).toBe("audit");
  });
});

describe("reducePhaseMachine", () => {
  it("does not complete a sequential same-phase pair until terminal", () => {
    const state = reducePhaseMachine(
      [start(1, "audit", "a"), end(1, "audit"), start(2, "audit", "b"), end(2, "audit")],
      "running",
    );
    expect(state.completed).toEqual([]);
    expect(state.frontier).toBe("audit");
    const done = reducePhaseMachine(
      [start(1, "audit", "a"), end(1, "audit"), start(2, "audit", "b"), end(2, "audit")],
      "completed",
    );
    expect(done.completed.map((c) => c.phase)).toEqual(["audit"]);
    expect(done.completed[0]?.ok).toBe(2);
    expect(done.completed[0]?.labels).toEqual(["a", "b"]);
  });

  it("emits one audit completion when a pipeline drains and verify starts", () => {
    const events: RunEvent[] = [
      start(1, "audit", "src/a.ts"),
      start(2, "audit", "src/b.ts"),
      end(1, "audit", true, 10),
      end(2, "audit", false, 5),
      start(3, "verify", "src/a.ts"),
    ];
    const state = reducePhaseMachine(events, "running");
    expect(state.completed.map((c) => c.phase)).toEqual(["audit"]);
    expect(state.completed[0]).toMatchObject({ ok: 1, failed: 1, tokens: 15 });
    expect(state.frontier).toBe("verify");
    expect(state.inFlight).toHaveLength(1);
    expect(state.inFlight[0]?.phase).toBe("verify");
  });

  it("completes the last phase on terminal status", () => {
    const state = reducePhaseMachine(
      [start(1, "verify", "x"), end(1, "verify")],
      "completed",
    );
    expect(state.completed.map((c) => c.phase)).toEqual(["verify"]);
  });

  it("groups unlabeled agents as (unlabeled)", () => {
    const state = reducePhaseMachine([start(1, undefined, "x"), end(1, undefined)], "completed");
    expect(state.completed[0]?.phase).toBe(UNLABELED_PHASE);
  });

  it("appends a second completion when a phase name is reused", () => {
    const events: RunEvent[] = [
      start(1, "audit"),
      end(1, "audit"),
      start(2, "verify"),
      end(2, "verify"),
      start(3, "audit"),
      end(3, "audit"),
    ];
    const state = reducePhaseMachine(events, "completed");
    expect(state.completed.map((c) => c.phase)).toEqual(["audit", "verify", "audit"]);
  });
});

describe("decideNotify", () => {
  const running: RunStatus = "running";

  it("prefers the next unconsumed phase_end", () => {
    const state = reducePhaseMachine(
      [start(1, "audit"), end(1, "audit"), start(2, "verify")],
      running,
    );
    const action = decideNotify({
      state,
      cursor: emptyCursor,
      runStatus: running,
      pidAlive: true,
      timeoutElapsed: true,
    });
    expect(action).toEqual({
      type: "phase_end",
      completion: state.completed[0],
    });
  });

  it("returns stale before terminal when a running pid is dead", () => {
    const state = reducePhaseMachine([start(1, "audit")], running);
    const action = decideNotify({
      state,
      cursor: emptyCursor,
      runStatus: running,
      pidAlive: false,
      timeoutElapsed: false,
    });
    expect(action).toEqual({ type: "stale" });
  });

  it("returns terminal when status is completed and cursor is open", () => {
    const state = reducePhaseMachine([start(1, "audit"), end(1, "audit")], "completed");
    const action = decideNotify({
      state,
      cursor: { phaseEnds: ["audit"], terminal: false },
      runStatus: "completed",
      pidAlive: false,
      timeoutElapsed: false,
    });
    expect(action).toEqual({ type: "terminal" });
  });

  it("returns heartbeat only after timeout while still running", () => {
    const state = reducePhaseMachine([start(1, "audit")], running);
    expect(
      decideNotify({
        state,
        cursor: emptyCursor,
        runStatus: running,
        pidAlive: true,
        timeoutElapsed: false,
      }).type,
    ).toBe("wait");
    expect(
      decideNotify({
        state,
        cursor: emptyCursor,
        runStatus: running,
        pidAlive: true,
        timeoutElapsed: true,
      }).type,
    ).toBe("heartbeat");
  });

  it("returns idle when a completed run is fully consumed", () => {
    const state = reducePhaseMachine([start(1, "audit"), end(1, "audit")], "completed");
    expect(
      decideNotify({
        state,
        cursor: { phaseEnds: ["audit"], terminal: true },
        runStatus: "completed",
        pidAlive: false,
        timeoutElapsed: true,
      }).type,
    ).toBe("idle");
  });

  it("does not treat pending with no pid as stale", () => {
    const state = reducePhaseMachine([], "pending");
    expect(
      decideNotify({
        state,
        cursor: emptyCursor,
        runStatus: "pending",
        pidAlive: false,
        timeoutElapsed: false,
      }).type,
    ).toBe("wait");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/runtime/phase-machine.test.ts`

Expected: FAIL with `Cannot find module './phase-machine.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/runtime/phase-machine.ts`:

```typescript
import { UNLABELED_PHASE } from "../constants.js";
import type { RunEvent, RunStatus, WatchCursor } from "../types.js";
import { assertNever } from "../util/assert-never.js";

export function normalizePhase(phase: string | undefined): string {
  return phase !== undefined && phase.length > 0 ? phase : UNLABELED_PHASE;
}

export interface PhaseCompletion {
  phase: string;
  ok: number;
  failed: number;
  cancelled: number;
  tokens: number;
  labels: string[];
}

export interface PhaseInFlight {
  phase: string;
  label: string | undefined;
  key: string;
  callIndex: number;
}

export interface PhaseMachineState {
  completed: PhaseCompletion[];
  inFlight: PhaseInFlight[];
  frontier: string | undefined;
}

export type NotifyAction =
  | { type: "phase_end"; completion: PhaseCompletion }
  | { type: "stale" }
  | { type: "terminal" }
  | { type: "heartbeat" }
  | { type: "wait" }
  | { type: "idle" };

interface WaveStats {
  ok: number;
  failed: number;
  cancelled: number;
  tokens: number;
  labels: string[];
}

function emptyWave(): WaveStats {
  return { ok: 0, failed: 0, cancelled: 0, tokens: 0, labels: [] };
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

function isActiveStatus(status: RunStatus): boolean {
  return (
    status === "pending" ||
    status === "planning" ||
    status === "running" ||
    status === "awaiting_approval"
  );
}

export function reducePhaseMachine(events: RunEvent[], runStatus: RunStatus): PhaseMachineState {
  const inFlight = new Map<number, PhaseInFlight>();
  const waves = new Map<string, WaveStats>();
  const startOrder: string[] = [];
  const completed: PhaseCompletion[] = [];
  let frontier: string | undefined;

  const runningCount = (phase: string): number => {
    let count = 0;
    for (const item of inFlight.values()) {
      if (item.phase === phase) {
        count += 1;
      }
    }
    return count;
  };

  const complete = (phase: string): void => {
    if (runningCount(phase) !== 0) {
      return;
    }
    const wave = waves.get(phase) ?? emptyWave();
    completed.push({ phase, ...wave });
    waves.set(phase, emptyWave());
    const index = startOrder.indexOf(phase);
    if (index >= 0) {
      startOrder.splice(index, 1);
    }
    if (frontier === phase) {
      frontier = undefined;
    }
  };

  for (const event of events) {
    switch (event.type) {
      case "agent_start": {
        const phase = normalizePhase(event.phase);
        if (frontier !== undefined && frontier !== phase && runningCount(frontier) === 0) {
          complete(frontier);
        }
        frontier = phase;
        inFlight.set(event.callIndex, {
          phase,
          label: event.label,
          key: event.key,
          callIndex: event.callIndex,
        });
        if (!startOrder.includes(phase)) {
          startOrder.push(phase);
        }
        const wave = waves.get(phase) ?? emptyWave();
        if (event.label !== undefined) {
          wave.labels.push(event.label);
        }
        waves.set(phase, wave);
        break;
      }
      case "agent_end": {
        const current = inFlight.get(event.callIndex);
        const phase = current?.phase ?? normalizePhase(event.phase);
        inFlight.delete(event.callIndex);
        const wave = waves.get(phase) ?? emptyWave();
        if (event.ok) {
          wave.ok += 1;
        } else {
          wave.failed += 1;
        }
        wave.tokens += event.tokens;
        waves.set(phase, wave);
        break;
      }
      case "status":
      case "warning":
      case "result":
        break;
      default: {
        assertNever(event);
      }
    }
  }

  if (isTerminalStatus(runStatus)) {
    for (const phase of [...startOrder]) {
      complete(phase);
    }
  }

  return { completed, inFlight: [...inFlight.values()], frontier };
}

export function decideNotify(input: {
  state: PhaseMachineState;
  cursor: WatchCursor;
  runStatus: RunStatus;
  pidAlive: boolean;
  timeoutElapsed: boolean;
}): NotifyAction {
  const next = input.state.completed[input.cursor.phaseEnds.length];
  if (next) {
    return { type: "phase_end", completion: next };
  }
  if (input.runStatus === "running" && !input.pidAlive && !input.cursor.terminal) {
    return { type: "stale" };
  }
  if (isTerminalStatus(input.runStatus) && !input.cursor.terminal) {
    return { type: "terminal" };
  }
  if (isActiveStatus(input.runStatus)) {
    return input.timeoutElapsed ? { type: "heartbeat" } : { type: "wait" };
  }
  return { type: "idle" };
}
```

- [ ] **Step 4: Run tests and make sure they pass**

Run: `npx vitest run src/runtime/phase-machine.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/constants.ts src/runtime/phase-machine.ts src/runtime/phase-machine.test.ts
git commit -m "feat: derive workflow phase completions from run events"
```

---

### Task 2: Watch flags and help

**Files:**
- Modify: `src/cli/flags.ts`
- Modify: `src/cli/flags.test.ts`
- Modify: `src/commands/help.ts`
- Modify: `src/commands/help.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_WATCH_TIMEOUT_SEC`, `isOutputFormat`, `CliError`
- Produces: `WatchFlags`; `parseWatchFlags(args: string[]): WatchFlags`; `WATCH_HELP`

- [ ] **Step 1: Write the failing tests**

Append to `src/cli/flags.test.ts` (extend the existing `./flags.js` import to include `parseWatchFlags`; do not add a second import):

```typescript
describe("parseWatchFlags", () => {
  it("defaults timeout to 300 and output to text", () => {
    const flags = parseWatchFlags(["--run", "cw_1"]);
    expect(flags.runId).toBe("cw_1");
    expect(flags.timeout).toBe(300);
    expect(flags.output).toBe("text");
    expect(flags.help).toBe(false);
  });

  it("parses --timeout 0 and --output json", () => {
    const flags = parseWatchFlags(["--timeout", "0", "--output", "json"]);
    expect(flags.timeout).toBe(0);
    expect(flags.output).toBe("json");
    expect(flags.runId).toBeUndefined();
  });

  it("rejects a negative timeout", () => {
    try {
      parseWatchFlags(["--timeout", "-1"]);
      throw new Error("expected CliError");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).example).toContain("cw watch --timeout 300");
    }
  });
});
```

Keep the existing `help copy` tests and add a second `it` in the same `describe`. Import `WATCH_HELP` from `./help.js` next to `ROOT_HELP` and `RUN_HELP`.

```typescript
  it("documents cw watch", () => {
    expect(ROOT_HELP).toContain("watch");
    expect(WATCH_HELP).toContain("cw watch [--run <id>] [--timeout 300]");
    expect(WATCH_HELP).toContain("cw watch --run cw_k1_ab12 --timeout 300 --output json");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/flags.test.ts src/commands/help.test.ts`

Expected: FAIL (`parseWatchFlags` is not exported; `WATCH_HELP` is not exported)

- [ ] **Step 3: Write minimal implementation**

Add to `src/cli/flags.ts` after `IdFlags`:

```typescript
export interface WatchFlags {
  runId: string | undefined;
  timeout: number;
  output: OutputFormat;
  help: boolean;
}
```

Import `DEFAULT_WATCH_TIMEOUT_SEC` from `../constants.js`.

Add `parseWatchFlags` after `parseIdFlags`:

```typescript
export function parseWatchFlags(args: string[]): WatchFlags {
  const { values } = parseArgs({
    args,
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
  return {
    runId: values.run,
    timeout: parseBoundedInt(
      values.timeout,
      DEFAULT_WATCH_TIMEOUT_SEC,
      0,
      86400,
      "--timeout",
    ),
    output: outputRaw,
    help: values.help === true,
  };
}
```

`parseBoundedInt` currently uses example `cw run ${flag} ...`. That example is wrong for `--timeout`. Change `parseBoundedInt` to take an optional example, **or** special-case `--timeout` in `parseWatchFlags` without changing the shared helper’s run-oriented example. Prefer a local check in `parseWatchFlags` for timeout so `--timeout` errors show `cw watch --timeout 300 --run <id>`:

Do **not** reuse `parseBoundedInt` for timeout. Parse it inline in `parseWatchFlags`:

```typescript
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
```

Add to `src/commands/help.ts` in the Commands list (after `status`):

```
  watch        Wait for the next phase, heartbeat, or run end
```

Add example:

```
  cw watch --run cw_k1_ab12
```

Append:

```typescript
export const WATCH_HELP = `cw watch — wait for the next workflow phase or heartbeat

Usage:
  cw watch [--run <id>] [--timeout 300] [--output text|json]

Options:
  --run <id>              Run id (default: latest)
  --timeout <seconds>     Wait this long for a phase end (default: 300; 0 waits forever)
  --output <text|json>    stdout format (default: text)
  -h, --help              Show this help

Examples:
  cw watch --run cw_k1_ab12
  cw watch --run cw_k1_ab12 --timeout 300 --output json
`;
```

- [ ] **Step 4: Run tests and make sure they pass**

Run: `npx vitest run src/cli/flags.test.ts src/commands/help.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/flags.ts src/cli/flags.test.ts src/commands/help.ts src/commands/help.test.ts
git commit -m "feat: add cw watch flags and help"
```

---

### Task 3: `cw watch` command

**Files:**
- Create: `src/store/watch-cursor.ts`
- Create: `src/store/watch-cursor.test.ts`
- Create: `src/commands/watch.ts`
- Create: `src/commands/watch.test.ts`

**Interfaces:**
- Consumes: `parseWatchFlags`, `WATCH_HELP`, `reducePhaseMachine`, `decideNotify`, `readRun`, `resolveRunId`, `listRuns`, `readLastEvents`, `writeResult`/`result.json`, `WATCH_POLL_MS`, `DEFAULT_WATCH_TIMEOUT_SEC`
- Produces: `readWatchCursor(cwd, runId)`, `writeWatchCursor(cwd, runId, cursor)`, `emptyWatchCursor()`, `watchCommand(argv, io?, cwd?, hooks?)`, `selectWatchRun(cwd, hooks?)`, `WatchCommandHooks`

- [ ] **Step 1: Write the failing tests**

Create `src/store/watch-cursor.test.ts`:

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeRun } from "./runs.js";
import { runFile } from "./paths.js";
import { emptyWatchCursor, readWatchCursor, writeWatchCursor } from "./watch-cursor.js";
import type { RunRecord } from "../types.js";

function record(cwd: string, id: string): RunRecord {
  const now = new Date().toISOString();
  return {
    id,
    status: "running",
    cwd,
    backend: "fake",
    model: "composer-2.5",
    createdAt: now,
    updatedAt: now,
    pid: 1,
    stopRequested: false,
    cancelPhases: [],
    cancelLabels: [],
    workflowPath: runFile(cwd, id, "workflow.js"),
    prompt: undefined,
    args: undefined,
    size: "medium",
    concurrency: 4,
    maxAgents: 100,
    error: undefined,
    agentCount: 0,
    tokens: 0,
  };
}

describe("watch-cursor", () => {
  it("returns an empty cursor when the file is missing", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      await writeRun(cwd, record(cwd, "cw_1"));
      expect(await readWatchCursor(cwd, "cw_1")).toEqual(emptyWatchCursor());
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("round-trips a cursor", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      await writeRun(cwd, record(cwd, "cw_1"));
      await writeWatchCursor(cwd, "cw_1", { phaseEnds: ["audit"], terminal: true });
      expect(await readWatchCursor(cwd, "cw_1")).toEqual({
        phaseEnds: ["audit"],
        terminal: true,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
```

Create `src/commands/watch.test.ts`:

```typescript
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { writeResult, writeRun } from "../store/runs.js";
import { runFile } from "../store/paths.js";
import { readWatchCursor } from "../store/watch-cursor.js";
import type { RunEvent, RunRecord } from "../types.js";
import { watchCommand } from "./watch.js";

function memoryStream(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
  return { stream, text: () => chunks.join("") };
}

function record(cwd: string, id: string, status: RunRecord["status"] = "running"): RunRecord {
  const now = new Date().toISOString();
  return {
    id,
    status,
    cwd,
    backend: "fake",
    model: "composer-2.5",
    createdAt: now,
    updatedAt: now,
    pid: 1,
    stopRequested: false,
    cancelPhases: [],
    cancelLabels: [],
    workflowPath: runFile(cwd, id, "workflow.js"),
    prompt: undefined,
    args: undefined,
    size: "medium",
    concurrency: 4,
    maxAgents: 100,
    error: undefined,
    agentCount: 0,
    tokens: 0,
  };
}

async function writeEvents(cwd: string, id: string, events: RunEvent[]): Promise<void> {
  await writeFile(
    runFile(cwd, id, "events.ndjson"),
    events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : ""),
    "utf8",
  );
}

describe("watchCommand", () => {
  it("returns the first unconsumed phase_end immediately and advances the cursor", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const id = "cw_w1";
      await writeRun(cwd, record(cwd, id));
      await writeEvents(cwd, id, [
        { type: "agent_start", at: "t", callIndex: 1, key: "a", label: "a", phase: "audit" },
        { type: "agent_end", at: "t", callIndex: 1, key: "a", ok: true, tokens: 3, phase: "audit" },
        { type: "agent_start", at: "t", callIndex: 2, key: "v", label: "v", phase: "verify" },
      ]);
      const stdout = memoryStream();
      const code = await watchCommand(
        ["--run", id, "--output", "json", "--timeout", "0"],
        { stdout: stdout.stream, stderr: stdout.stream },
        cwd,
        { isPidAlive: () => true },
      );
      expect(code).toBe(0);
      const payload = JSON.parse(stdout.text()) as { reason: string; phase: string };
      expect(payload.reason).toBe("phase_end");
      expect(payload.phase).toBe("audit");
      expect(await readWatchCursor(cwd, id)).toEqual({ phaseEnds: ["audit"], terminal: false });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns phase_end before terminal when both are pending", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const id = "cw_w2";
      await writeRun(cwd, record(cwd, id, "completed"));
      await writeEvents(cwd, id, [
        { type: "agent_start", at: "t", callIndex: 1, key: "a", phase: "audit" },
        { type: "agent_end", at: "t", callIndex: 1, key: "a", ok: true, tokens: 1, phase: "audit" },
      ]);
      await writeResult(cwd, id, { ok: true });
      const first = memoryStream();
      await watchCommand(["--run", id, "--output", "json"], { stdout: first.stream, stderr: first.stream }, cwd, {
        isPidAlive: () => false,
      });
      expect(JSON.parse(first.text()).reason).toBe("phase_end");
      const second = memoryStream();
      await watchCommand(["--run", id, "--output", "json"], { stdout: second.stream, stderr: second.stream }, cwd, {
        isPidAlive: () => false,
      });
      const payload = JSON.parse(second.text()) as { reason: string; resultPreview: unknown };
      expect(payload.reason).toBe("terminal");
      expect(payload.resultPreview).toEqual({ ok: true });
      expect(await readWatchCursor(cwd, id)).toEqual({ phaseEnds: ["audit"], terminal: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns heartbeat after timeout without advancing the cursor", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const id = "cw_w3";
      await writeRun(cwd, record(cwd, id));
      await writeEvents(cwd, id, [
        { type: "agent_start", at: "t", callIndex: 1, key: "a", label: "a", phase: "audit" },
      ]);
      let now = 0;
      const stdout = memoryStream();
      const code = await watchCommand(
        ["--run", id, "--output", "json", "--timeout", "1"],
        { stdout: stdout.stream, stderr: stdout.stream },
        cwd,
        {
          isPidAlive: () => true,
          now: () => now,
          sleep: async () => {
            now = 2000;
          },
        },
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.text()).reason).toBe("heartbeat");
      expect(await readWatchCursor(cwd, id)).toEqual({ phaseEnds: [], terminal: false });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns stale when a running pid is dead and consumes terminal", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const id = "cw_w4";
      await writeRun(cwd, record(cwd, id));
      await writeEvents(cwd, id, [
        { type: "agent_start", at: "t", callIndex: 1, key: "a", phase: "audit" },
      ]);
      const stdout = memoryStream();
      const code = await watchCommand(
        ["--run", id, "--output", "json"],
        { stdout: stdout.stream, stderr: stdout.stream },
        cwd,
        { isPidAlive: () => false },
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.text()).reason).toBe("stale");
      expect(await readWatchCursor(cwd, id)).toEqual({ phaseEnds: [], terminal: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prints help and does not require a run", async () => {
    const stdout = memoryStream();
    const code = await watchCommand(["--help"], { stdout: stdout.stream, stderr: stdout.stream });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("cw watch");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/store/watch-cursor.test.ts src/commands/watch.test.ts`

Expected: FAIL (modules not found)

- [ ] **Step 3: Write minimal implementation**

Create `src/store/watch-cursor.ts`:

```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WatchCursor } from "../types.js";
import { runFile } from "./paths.js";

export function emptyWatchCursor(): WatchCursor {
  return { phaseEnds: [], terminal: false };
}

export async function readWatchCursor(cwd: string, runId: string): Promise<WatchCursor> {
  try {
    const raw = await readFile(runFile(cwd, runId, "watch-cursor.json"), "utf8");
    const parsed = JSON.parse(raw) as WatchCursor;
    return {
      phaseEnds: Array.isArray(parsed.phaseEnds) ? parsed.phaseEnds.map(String) : [],
      terminal: parsed.terminal === true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyWatchCursor();
    }
    throw error;
  }
}

export async function writeWatchCursor(cwd: string, runId: string, cursor: WatchCursor): Promise<void> {
  const filePath = runFile(cwd, runId, "watch-cursor.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
}
```

Create `src/commands/watch.ts`:

```typescript
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

async function snapshot(
  cwd: string,
  runId: string,
  probe: (pid: number) => boolean,
): Promise<{
  record: RunRecord;
  state: PhaseMachineState;
  cursor: WatchCursor;
  action: NotifyAction;
  timeoutElapsed: boolean;
}> {
  const record = await readRun(cwd, runId);
  const events = await readLastEvents(runFile(cwd, runId, "events.ndjson"), Number.MAX_SAFE_INTEGER);
  const cursor = await readWatchCursor(cwd, runId);
  const state = reducePhaseMachine(events, record.status);
  return {
    record,
    state,
    cursor,
    action: decideNotify({
      state,
      cursor,
      runStatus: record.status,
      pidAlive: pidAliveFor(record, probe),
      timeoutElapsed: false,
    }),
    timeoutElapsed: false,
  };
}

export async function selectWatchRun(
  cwd: string,
  hooks: WatchCommandHooks = {},
): Promise<string | undefined> {
  const probe = hooks.isPidAlive ?? isPidAlive;
  const runs = await listRuns(cwd);
  const interesting: RunRecord[] = [];
  for (const run of runs) {
    const current = await snapshot(cwd, run.id, probe);
    if (current.action.type !== "idle") {
      interesting.push(run);
    }
  }
  const active = interesting.find(
    (run) =>
      run.status === "pending" ||
      run.status === "planning" ||
      run.status === "running" ||
      run.status === "awaiting_approval",
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
```

Remove the unused `emptyWatchCursor` import from `watch.ts` if the compiler flags it. Do not import unused symbols.

Fix `snapshot` if unused — `selectWatchRun` should inline the same reads rather than a half-used helper. Keep `selectWatchRun` using the same `decideNotify` path as above. Delete `snapshot` if it is unused after edits.

- [ ] **Step 4: Run tests and make sure they pass**

Run: `npx vitest run src/store/watch-cursor.test.ts src/commands/watch.test.ts src/runtime/phase-machine.test.ts`

Expected: PASS

If the heartbeat test loops forever, `decideNotify` must see `timeoutElapsed: true` on the second iteration (`now` jumps to 2000, timeout 1s). Do not sleep when `timeoutElapsed` is already true.

If idle-on-consumed-completed is hit in the “phase then terminal” test, the second call must be `terminal` not `idle`. After phase_end, cursor is `{ phaseEnds: ["audit"], terminal: false }` and status is `completed` → `decideNotify` returns `terminal`.

- [ ] **Step 5: Commit**

```bash
git add src/store/watch-cursor.ts src/store/watch-cursor.test.ts src/commands/watch.ts src/commands/watch.test.ts
git commit -m "feat: add cw watch for phase ends and heartbeats"
```

---

### Task 4: CLI dispatch

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**
- Consumes: `watchCommand`
- Produces: `cw watch` and `cw help watch` dispatch

- [ ] **Step 1: Write the failing test**

Append to `src/cli.test.ts`:

```typescript
  it("prints watch help for help watch and watch --help", async () => {
    for (const argv of [["help", "watch"], ["watch", "--help"]]) {
      const stdout = memoryStream();
      const code = await runCli(argv, {
        stdout: stdout.stream,
        stderr: stdout.stream,
        stdinIsTTY: false,
        chat: async () => 0,
      });
      expect(code).toBe(0);
      expect(stdout.text()).toContain("cw watch");
      expect(stdout.text()).toContain("--timeout");
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli.test.ts`

Expected: FAIL (`unknown command: watch` or missing timeout in help)

- [ ] **Step 3: Write minimal implementation**

In `src/cli.ts` import `watchCommand` from `./commands/watch.js`.

In `dispatch`:

```typescript
    case "watch":
      return watchCommand(rest);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/cli.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat: dispatch cw watch from the root CLI"
```

---

### Task 5: Orchestrator stop hook

**Files:**
- Create: `src/hooks/orchestrator-stop.ts`
- Create: `src/hooks/orchestrator-stop.test.ts`

**Interfaces:**
- Consumes: `selectWatchRun`, `WatchPayload`
- Produces: `runOrchestratorStopHook(input, hooks?)`; `StopHookInput`

- [ ] **Step 1: Write the failing tests**

Create `src/hooks/orchestrator-stop.test.ts`:

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { writeRun } from "../store/runs.js";
import { runFile } from "../store/paths.js";
import type { RunRecord } from "../types.js";
import { runOrchestratorStopHook } from "./orchestrator-stop.js";

function memoryStream(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
  return { stream, text: () => chunks.join("") };
}

function record(cwd: string, id: string): RunRecord {
  const now = new Date().toISOString();
  return {
    id,
    status: "completed",
    cwd,
    backend: "fake",
    model: "composer-2.5",
    createdAt: now,
    updatedAt: now,
    pid: 1,
    stopRequested: false,
    cancelPhases: [],
    cancelLabels: [],
    workflowPath: runFile(cwd, id, "workflow.js"),
    prompt: undefined,
    args: undefined,
    size: "medium",
    concurrency: 4,
    maxAgents: 100,
    error: undefined,
    agentCount: 0,
    tokens: 0,
  };
}

describe("runOrchestratorStopHook", () => {
  it("prints {} on aborted", async () => {
    const stdout = memoryStream();
    let watched = 0;
    await runOrchestratorStopHook(
      { status: "aborted", loop_count: 0 },
      {
        stdout: stdout.stream,
        watch: async () => {
          watched += 1;
          return { stdout: "{}", exitCode: 0 };
        },
      },
    );
    expect(stdout.text()).toBe("{}\n");
    expect(watched).toBe(0);
  });

  it("prints {} when there is no watch target", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      const stdout = memoryStream();
      await runOrchestratorStopHook(
        { status: "completed", loop_count: 0, workspace_roots: [cwd] },
        { stdout: stdout.stream, cwd },
      );
      expect(stdout.text()).toBe("{}\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns a [cw-watch] followup from watch JSON", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    try {
      await writeRun(cwd, { ...record(cwd, "cw_h1"), status: "running" });
      const stdout = memoryStream();
      const snapshot = {
        reason: "phase_end",
        run: { id: "cw_h1" },
        phase: "audit",
        summary: { phase: "audit", ok: 1, failed: 0, cancelled: 0, tokens: 1, labels: ["a"], inFlight: [] },
        resultPreview: null,
      };
      await runOrchestratorStopHook(
        { status: "completed", loop_count: 0, workspace_roots: [cwd] },
        {
          cwd,
          stdout: stdout.stream,
          selectRun: async () => "cw_h1",
          watch: async (args) => {
            expect(args).toEqual(["--run", "cw_h1", "--timeout", "300", "--output", "json"]);
            return { stdout: `${JSON.stringify(snapshot)}\n`, exitCode: 0 };
          },
        },
      );
      const payload = JSON.parse(stdout.text()) as { followup_message: string };
      expect(payload.followup_message).toContain("[cw-watch]");
      expect(payload.followup_message).toContain("reason=phase_end");
      expect(payload.followup_message).toContain("Summarize this to the user");
      expect(payload.followup_message).not.toContain("last automatic check");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("mentions the last automatic check when loop_count is 79", async () => {
    const stdout = memoryStream();
    await runOrchestratorStopHook(
      { status: "completed", loop_count: 79, workspace_roots: ["/repo"] },
      {
        cwd: "/repo",
        stdout: stdout.stream,
        selectRun: async () => "cw_h1",
        watch: async () => ({
          stdout: `${JSON.stringify({ reason: "heartbeat", run: { id: "cw_h1" }, phase: "audit", summary: { phase: "audit", ok: 0, failed: 0, cancelled: 0, tokens: 0, labels: [], inFlight: [] }, resultPreview: null })}\n`,
          exitCode: 0,
        }),
      },
    );
    expect(JSON.parse(stdout.text()).followup_message).toContain("last automatic check");
  });

  it("prints {} when watch fails", async () => {
    const stdout = memoryStream();
    await runOrchestratorStopHook(
      { status: "completed", loop_count: 0, workspace_roots: ["/repo"] },
      {
        cwd: "/repo",
        stdout: stdout.stream,
        selectRun: async () => "cw_h1",
        watch: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(stdout.text()).toBe("{}\n");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/hooks/orchestrator-stop.test.ts`

Expected: FAIL (module not found)

- [ ] **Step 3: Write minimal implementation**

Create `src/hooks/orchestrator-stop.ts`:

```typescript
import { execa } from "execa";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WATCH_TIMEOUT_SEC } from "../constants.js";
import { selectWatchRun } from "../commands/watch.js";
import type { CommandIo } from "../commands/run.js";

export interface StopHookInput {
  status?: string;
  loop_count?: number;
  workspace_roots?: string[];
}

export interface StopHookHooks {
  cwd?: string;
  stdout?: CommandIo["stdout"];
  selectRun?: (cwd: string) => Promise<string | undefined>;
  watch?: (args: string[]) => Promise<{ stdout: string; exitCode: number }>;
  cliPath?: string;
}

function packageCliPath(from: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(from)), "../../dist/cli.js");
}

function empty(stdout: CommandIo["stdout"]): void {
  stdout.write("{}\n");
}

export async function runOrchestratorStopHook(
  input: StopHookInput,
  hooks: StopHookHooks = {},
): Promise<void> {
  const stdout = hooks.stdout ?? process.stdout;
  try {
    if (input.status === "aborted") {
      empty(stdout);
      return;
    }
    const cwd = hooks.cwd ?? input.workspace_roots?.[0] ?? process.cwd();
    const runId = await (hooks.selectRun ?? selectWatchRun)(cwd);
    if (!runId) {
      empty(stdout);
      return;
    }
    const args = ["--run", runId, "--timeout", String(DEFAULT_WATCH_TIMEOUT_SEC), "--output", "json"];
    const watch =
      hooks.watch ??
      (async (watchArgs: string[]) => {
        const cliPath = hooks.cliPath ?? packageCliPath();
        const result = await execa(process.execPath, [cliPath, "watch", ...watchArgs], {
          cwd,
          reject: false,
        });
        return { stdout: result.stdout, exitCode: result.exitCode ?? 1 };
      });
    const result = await watch(args);
    if (result.exitCode !== 0) {
      empty(stdout);
      return;
    }
    const snapshot = result.stdout.trim();
    let reason = "unknown";
    try {
      reason = String((JSON.parse(snapshot) as { reason?: string }).reason ?? "unknown");
    } catch {
      empty(stdout);
      return;
    }
    const last =
      input.loop_count === 79
        ? "\nThis is the last automatic check. Say keep watching if the run is still going."
        : "";
    const followup_message = `[cw-watch] reason=${reason} run=${runId}
${snapshot}
Summarize this to the user. Do not start new fan-out work unless they asked. Do not sleep.${last}`;
    stdout.write(`${JSON.stringify({ followup_message })}\n`);
  } catch {
    empty(stdout);
  }
}
```

`packageCliPath`: `src/hooks/` → `../../dist/cli.js` is package-root `dist/cli.js` when compiled (`dist/hooks/` → `../../dist/cli.js` is also package `dist/cli.js`). Good.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/hooks/orchestrator-stop.test.ts src/commands/watch.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/orchestrator-stop.ts src/hooks/orchestrator-stop.test.ts
git commit -m "feat: fail-open stop hook that follows cw watch"
```

---

### Task 6: Bundle plugin hooks and skill

**Files:**
- Modify: `plugin/.cursor-plugin/plugin.json`
- Create: `plugin/hooks/hooks.json`
- Create: `plugin/hooks/orchestrator-stop.js`
- Modify: `plugin/skills/cw-orchestrator/SKILL.md`
- Modify: `src/plugin-manifest.test.ts`

**Interfaces:**
- Consumes: `runOrchestratorStopHook` from `dist/hooks/orchestrator-stop.js`
- Produces: plugin `stop` hook with `timeout` 330 and `loop_limit` 80; skill Watch section

- [ ] **Step 1: Write the failing tests**

Replace `src/plugin-manifest.test.ts` with:

```typescript
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("bundled plugin", () => {
  it("declares the orchestrator skill", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(root, "plugin/.cursor-plugin/plugin.json"), "utf8"),
    ) as { name: string; skills: string; hooks: string };
    expect(manifest.name).toBe("cursor-workflows");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.hooks).toBe("./hooks/hooks.json");
    const skill = await readFile(path.join(root, "plugin/skills/cw-orchestrator/SKILL.md"), "utf8");
    expect(skill).toContain("cw run");
    expect(skill).toContain("--detach");
    expect(skill).toContain("cw stop --run");
    expect(skill).not.toContain("submit_workflow");
    expect(skill.toLowerCase()).toContain("agent login");
    expect(skill).toContain("[cw-watch]");
    expect(skill).toContain("phase summary");
    expect(skill).not.toContain("sleep 300");
    expect(skill.toLowerCase()).not.toContain("only status when asked");
  });

  it("ships a stop hook that watches runs", async () => {
    const hooks = JSON.parse(
      await readFile(path.join(root, "plugin/hooks/hooks.json"), "utf8"),
    ) as {
      version: number;
      hooks: { stop: Array<{ command: string; timeout: number; loop_limit: number | null }> };
    };
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.stop[0]?.command).toBe("node ./hooks/orchestrator-stop.js");
    expect(hooks.hooks.stop[0]?.timeout).toBe(330);
    expect(hooks.hooks.stop[0]?.loop_limit).toBe(80);
    const script = await readFile(path.join(root, "plugin/hooks/orchestrator-stop.js"), "utf8");
    expect(script).toContain("runOrchestratorStopHook");
    expect(script).toContain("../../dist/hooks/orchestrator-stop.js");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/plugin-manifest.test.ts`

Expected: FAIL (missing `hooks` field / files / skill phrases)

- [ ] **Step 3: Write minimal implementation**

Update `plugin/.cursor-plugin/plugin.json` to include `"hooks": "./hooks/hooks.json"` next to `"skills": "./skills/"`.

Create `plugin/hooks/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "stop": [
      {
        "command": "node ./hooks/orchestrator-stop.js",
        "timeout": 330,
        "loop_limit": 80
      }
    ]
  }
}
```

Create `plugin/hooks/orchestrator-stop.js`:

```javascript
import { readFileSync } from "node:fs";
import { runOrchestratorStopHook } from "../../dist/hooks/orchestrator-stop.js";

let raw = "{}";
try {
  raw = readFileSync(0, "utf8") || "{}";
} catch {
  raw = "{}";
}

let input = {};
try {
  input = JSON.parse(raw);
} catch {
  process.stdout.write("{}\n");
  process.exit(0);
}

await runOrchestratorStopHook(input);
```

Replace `plugin/skills/cw-orchestrator/SKILL.md` with:

```markdown
---
name: cw-orchestrator
description: >-
  Orchestrate Cursor workflows with cw: plan a JS workflow, run it in the
  background, and map mid-run user chat to cw status/stop/resume. Use when the
  user wants a workflow, fan-out across files, ultracode-style multi-agent
  work, or to inspect/stop a cw run while continuing the conversation.
---

# cw orchestrator

You are the parent orchestrator. You do not implement large fan-out tasks turn by turn. You write and steer `cw` workflows. Intermediate worker results stay in the script; you only pull summaries via `cw status` or automatic `[cw-watch]` follow-ups.

Auth is `agent login`. Do not ask for `CURSOR_API_KEY` unless the user explicitly wants `--backend sdk`.

## Plan then run

1. `cw run "<task>" --dry-run`
2. Show planned phases from `meta` and `phase:` labels in the script. Ask to run. Offer to print or edit `workflow.js`.
3. Wait for the user (Yes / change the plan / No). Do not pass `--yes` on a planner `cw run` unless they already approved.
4. On Yes: `cw run --file <workflow.js> --detach`. Tell them the run id. Keep chatting.

## Watch (automatic)

After `--detach`, expect `[cw-watch]` messages from the stop hook. Do not `sleep`, do not busy-loop `cw status`, and do not hold a long shell wait.

On `[cw-watch]`:

- `phase_end` → write a short **phase summary** to the user (3–8 lines): phase name, ok/fail counts, up to 8 labels then “and N more”, tokens if non-zero, and one sentence on what is in flight if present. Do not dump the raw JSON.
- `heartbeat` → 1–3 lines: still running, current phase, in-flight labels.
- `terminal` / `stale` → close out the run in this session (read `result.json` / error if needed).

Do not start new fan-out work unless the user asked. User messages still win.

## Mid-run chat (never stdin into the script)

- What is happening → `cw status --run <id> --output json`
- "stop verify" → `cw stop --run <id> --phase verify`
- "pause / stop everything" → `cw stop --run <id>`
- "continue" → `cw resume --run <id>`
- "keep watching" → `cw watch --run <id> --output json` once, then summarize
- "only src/api" → `cw stop --run <id>`, edit `workflow.js`, then `cw run --file … --detach` (new run id). Do not splice a live script.

When the run is `completed` (status or `[cw-watch] terminal`), read the result and answer in this session.

Headless users can still `cw run "…" --yes` without this chat.
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/plugin-manifest.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin src/plugin-manifest.test.ts
git commit -m "feat: ship orchestrator stop hook and watch skill"
```

---

### Task 7: README and regression

**Files:**
- Modify: `README.md`
- Modify: `src/commands/run.test.ts` (no logic change unless a test fails)

**Interfaces:**
- Consumes: existing fake `cw run --file` path
- Produces: README documents automatic phase summaries and `cw watch`

- [ ] **Step 1: Write the failing test**

Add to `src/commands/help.test.ts` (or a tiny README assertion is optional). Prefer a real README phrase check in `src/plugin-manifest.test.ts` **only if** you want a lock; otherwise treat README as part of this task without a new test file.

Add imports at the top of `src/commands/help.test.ts`:

```typescript
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
```

Add this `it` inside the existing `describe("help copy")` block:

```typescript
  it("README documents automatic phase summaries and cw watch", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const readme = await readFile(path.join(root, "README.md"), "utf8");
    expect(readme).toContain("cw watch");
    expect(readme.toLowerCase()).toContain("phase summary");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/commands/help.test.ts`

Expected: FAIL (README missing phrases)

- [ ] **Step 3: Write minimal implementation**

In `README.md`, after the sentence about chat during a run, replace that paragraph with:

```markdown
Chat during a run goes to the orchestrator, not into `workflow.js`. Use `cw status`, `cw stop --phase <name>`, `cw resume`, and `cw watch`.

In a `cw` / `cw chat` session, a detached run posts a phase summary when each phase ends and a short heartbeat about every 5 minutes. Headless `cw run --detach` does not print those into chat; inspect with `cw status` or `cw watch`.
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`

Expected: PASS, including `src/commands/run.test.ts` fake-backend file workflow.

- [ ] **Step 5: Commit**

```bash
git add README.md src/commands/help.test.ts
git commit -m "docs: document automatic phase summaries in cw chat"
```

---

## Self-review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| Phase completion definition / sequential same-phase | Task 1 |
| Unlabeled + reused phase names | Task 1 |
| `cw watch` CLI, timeout default 300, timeout 0, json | Tasks 2–4 |
| Consume cursor; heartbeat does not advance | Task 3 |
| One reason per invocation; phase_end before terminal | Task 3 |
| Stale running pid | Tasks 1, 3 |
| Pending without pid is not stale | Task 1 |
| Stop hook aborted / fail-open / `[cw-watch]` / loop_count 79 | Task 5 |
| Plugin hooks.json timeout 330 loop_limit 80 | Task 6 |
| Skill: no sleep 300; phase summaries | Task 6 |
| README + headless unchanged | Task 7 |
| No MCP | Global constraint |
| `cw status` does not touch watch cursor | Task 3 (status untouched) |

**Placeholder scan:** none remaining. Plugin-load fallback from the spec is **not** implemented (assumption: `--plugin-dir` loads hooks). If a later live probe shows CLI ignores plugin hooks, add a follow-up spec; do not write `~/.cursor/hooks.json`.

**Type consistency:** `WatchCursor.phaseEnds: string[]` + `terminal: boolean`; `NotifyAction.type` is `phase_end` \| `stale` \| `terminal` \| `heartbeat` \| `wait` \| `idle`; `WatchPayload.reason` is `WatchReason`; hook follow-up prefix is `[cw-watch]`.
