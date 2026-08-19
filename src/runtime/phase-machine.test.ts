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

  it("does not complete the frontier phase between sequential same-phase calls", () => {
    const events: RunEvent[] = [
      start(1, "audit"),
      start(2, "verify"),
      end(1, "audit"),
      end(2, "verify"),
      start(3, "verify"),
    ];
    const running = reducePhaseMachine(events, "running");
    expect(running.completed.map((c) => c.phase)).toEqual(["audit"]);
    expect(running.frontier).toBe("verify");
    const done = reducePhaseMachine(
      [...events, end(3, "verify")],
      "completed",
    );
    expect(done.completed.map((c) => c.phase)).toEqual(["audit", "verify"]);
    expect(done.completed[1]?.ok).toBe(2);
  });

  it("completes an overlapping audit phase as soon as it drains", () => {
    const events: RunEvent[] = [
      start(1, "audit", "a"),
      start(2, "audit", "b"),
      end(1, "audit"),
      start(3, "verify", "a"),
      end(2, "audit"),
    ];
    const state = reducePhaseMachine(events, "running");
    expect(state.completed.map((completion) => completion.phase)).toEqual(["audit"]);
    expect(state.completed[0]).toMatchObject({ ok: 2, failed: 0, cancelled: 0 });
    expect(state.frontier).toBe("verify");
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

  it("counts cancelled agent ends separately from failures", () => {
    const state = reducePhaseMachine(
      [
        start(1, "audit"),
        {
          type: "agent_end",
          at: "t",
          callIndex: 1,
          key: "k1",
          ok: false,
          cancelled: true,
          tokens: 0,
          phase: "audit",
        },
      ],
      "completed",
    );
    expect(state.completed[0]).toMatchObject({ ok: 0, failed: 0, cancelled: 1 });
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

  it("returns idle after a stale running run has been consumed", () => {
    const state = reducePhaseMachine([start(1, "audit")], running);
    expect(
      decideNotify({
        state,
        cursor: { phaseEnds: [], terminal: true },
        runStatus: running,
        pidAlive: false,
        timeoutElapsed: true,
      }).type,
    ).toBe("idle");
  });

  it("returns idle while a run is awaiting approval", () => {
    const state = reducePhaseMachine([], "awaiting_approval");
    expect(
      decideNotify({
        state,
        cursor: emptyCursor,
        runStatus: "awaiting_approval",
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
