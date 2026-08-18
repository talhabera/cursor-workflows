import { describe, expect, it, vi } from "vitest";
import type { WorkerRequest } from "../types.js";

const cancelCalls: string[] = [];

vi.mock("@cursor/sdk", () => {
  class CursorAgentError extends Error {}

  return {
    CursorAgentError,
    Agent: {
      create: vi.fn(async () => ({
        async [Symbol.asyncDispose](): Promise<void> {
          // no-op
        },
        send: async () => {
          let cancelled = false;
          return {
            cancel: async (): Promise<void> => {
              cancelled = true;
              cancelCalls.push("cancel");
            },
            wait: async (): Promise<unknown> => {
              // Simulate a slow-running agent turn so an abort mid-flight is observable.
              for (let i = 0; i < 20 && !cancelled; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
              if (cancelled) {
                return { status: "cancelled", id: "run-1", usage: { totalTokens: 0 } };
              }
              return {
                status: "finished",
                id: "run-1",
                result: "done",
                usage: { totalTokens: 3 },
              };
            },
          };
        },
      })),
    },
  };
});

const { SdkWorkerBackend } = await import("./sdk.js");

function baseRequest(signal: AbortSignal): WorkerRequest {
  return {
    prompt: "do the thing",
    cwd: process.cwd(),
    model: "composer-2.5",
    tools: "read",
    schema: undefined,
    label: undefined,
    phase: undefined,
    isolation: "cwd",
    signal,
  };
}

describe("SdkWorkerBackend", () => {
  it("forwards an aborted request.signal into a run cancellation instead of letting the turn run to completion", async () => {
    cancelCalls.length = 0;
    const backend = new SdkWorkerBackend({ apiKey: "test-key", defaultModel: "composer-2.5" });
    const controller = new AbortController();
    const resultPromise = backend.start(baseRequest(controller.signal));
    controller.abort();
    const result = await resultPromise;
    expect(cancelCalls).toEqual(["cancel"]);
    expect(result.status).toBe("cancelled");
  });

  it("does not cancel a run whose signal is never aborted", async () => {
    cancelCalls.length = 0;
    const backend = new SdkWorkerBackend({ apiKey: "test-key", defaultModel: "composer-2.5" });
    const controller = new AbortController();
    const result = await backend.start(baseRequest(controller.signal));
    expect(cancelCalls).toEqual([]);
    expect(result.status).toBe("finished");
  });
});
