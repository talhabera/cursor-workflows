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
  return status === "pending" || status === "planning" || status === "running";
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

  const completeIdlePhases = (): void => {
    if (startOrder.length < 2) {
      return;
    }
    for (const phase of [...startOrder]) {
      if (runningCount(phase) === 0) {
        complete(phase);
      }
    }
  };

  for (const event of events) {
    switch (event.type) {
      case "agent_start": {
        const phase = normalizePhase(event.phase);
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
        completeIdlePhases();
        break;
      }
      case "agent_end": {
        const current = inFlight.get(event.callIndex);
        const phase = current?.phase ?? normalizePhase(event.phase);
        inFlight.delete(event.callIndex);
        const wave = waves.get(phase) ?? emptyWave();
        if (event.ok) {
          wave.ok += 1;
        } else if (event.cancelled === true) {
          wave.cancelled += 1;
        } else {
          wave.failed += 1;
        }
        wave.tokens += event.tokens;
        waves.set(phase, wave);
        completeIdlePhases();
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
  if (input.runStatus === "awaiting_approval") {
    return { type: "idle" };
  }
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
  if (
    input.cursor.terminal &&
    (isTerminalStatus(input.runStatus) ||
      (input.runStatus === "running" && !input.pidAlive))
  ) {
    return { type: "idle" };
  }
  if (isActiveStatus(input.runStatus)) {
    return input.timeoutElapsed ? { type: "heartbeat" } : { type: "wait" };
  }
  return { type: "idle" };
}
