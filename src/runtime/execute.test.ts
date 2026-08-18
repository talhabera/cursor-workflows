import { describe, expect, it } from "vitest";
import { WorkflowLimitError } from "../errors.js";
import { FakeWorkerBackend } from "../workers/fake.js";
import type { ProgressSink } from "../progress.js";
import { executeWorkflow } from "./execute.js";
import { Journal } from "./journal.js";

const silent: ProgressSink = { emit: async () => undefined };

function runOptions(overrides: Partial<Parameters<typeof executeWorkflow>[0]> = {}) {
  return {
    source: "",
    args: undefined,
    cwd: process.cwd(),
    runId: "test",
    backend: new FakeWorkerBackend(),
    journal: new Journal(),
    model: "composer-2.5",
    concurrency: 2,
    maxAgents: 100,
    signal: new AbortController().signal,
    progress: silent,
    ...overrides,
  };
}

describe("executeWorkflow", () => {
  it("runs pipeline with a rolling window under the concurrency cap", async () => {
    const backend = new FakeWorkerBackend(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { file: request.label };
    });
    const source = `
export const meta = { name: "pipe", description: "pipeline" }
const items = ["a", "b", "c", "d", "e", "f"]
return pipeline(items, (file) => agent("audit " + file, { label: file, phase: "audit" }))
`;
    const executed = await executeWorkflow(
      runOptions({ source, backend, concurrency: 2 }),
    );
    expect(executed.result).toEqual([
      { file: "a" },
      { file: "b" },
      { file: "c" },
      { file: "d" },
      { file: "e" },
      { file: "f" },
    ]);
    expect(backend.maxConcurrent).toBeLessThanOrEqual(2);
    expect(executed.agentCount).toBe(6);
  });

  it("replays completed journal entries on resume", async () => {
    const journal = new Journal([
      {
        callIndex: 1,
        key: "a",
        prompt: "A",
        label: "a",
        phase: undefined,
        status: "completed",
        result: { cached: true },
        tokens: 4,
        workerId: "old",
      },
    ]);
    const backend = new FakeWorkerBackend(async (request) => ({ live: request.label }));
    const source = `
export const meta = { name: "resume", description: "resume" }
const a = await agent("A", { label: "a" })
const b = await agent("B", { label: "b" })
return { a, b }
`;
    const executed = await executeWorkflow(runOptions({ source, backend, journal }));
    expect(executed.result).toEqual({ a: { cached: true }, b: { live: "b" } });
    expect(backend.starts).toHaveLength(1);
    expect(backend.starts[0]?.label).toBe("b");
    expect(executed.tokens).toBe(5);
  });

  it("returns null when schema validation fails", async () => {
    const backend = new FakeWorkerBackend(async () => ({ wrong: true }));
    const source = `
export const meta = { name: "schema", description: "schema" }
return agent("x", {
  label: "x",
  schema: { type: "object", required: ["files"], properties: { files: { type: "array" } } },
})
`;
    const executed = await executeWorkflow(runOptions({ source, backend }));
    expect(executed.result).toBeNull();
  });

  it("turns throwing parallel thunks into null", async () => {
    const source = `
export const meta = { name: "par", description: "parallel" }
return parallel([
  async () => 1,
  async () => { throw new Error("boom") },
])
`;
    const executed = await executeWorkflow(runOptions({ source }));
    expect(executed.result).toEqual([1, null]);
  });

  it("throws when Date.now is used", async () => {
    const source = `
export const meta = { name: "date", description: "date" }
return Date.now()
`;
    await expect(executeWorkflow(runOptions({ source }))).rejects.toThrow(/Date\.now/);
  });

  it("throws when the agent cap is exceeded", async () => {
    const source = `
export const meta = { name: "cap", description: "cap" }
await agent("one", { label: "one" })
await agent("two", { label: "two" })
await agent("three", { label: "three" })
`;
    await expect(executeWorkflow(runOptions({ source, maxAgents: 2 }))).rejects.toBeInstanceOf(
      WorkflowLimitError,
    );
  });

  it("exposes args to the script", async () => {
    const source = `
export const meta = { name: "args", description: "args" }
return args.dir
`;
    const executed = await executeWorkflow(runOptions({ source, args: { dir: "src/routes" } }));
    expect(executed.result).toBe("src/routes");
  });
});
