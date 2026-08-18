import { describe, expect, it } from "vitest";
import { WorkflowSandboxError } from "../errors.js";
import { extractSourceFromText, planWorkflow } from "./generate.js";
import { FakeWorkerBackend } from "../workers/fake.js";

const LEGAL = `export const meta = { name: "x", description: "x" }
await agent("hi")
`;

describe("extractSourceFromText", () => {
  it("reads a javascript fence that contains agent()", () => {
    const text = "Here is the script:\n```javascript\nexport const meta = { name: \"x\" }\nawait agent(\"hi\")\n```\n";
    expect(extractSourceFromText(text)).toContain("await agent");
  });
});

describe("planWorkflow", () => {
  it("unwraps source from a worker result object", async () => {
    const backend = new FakeWorkerBackend(() => ({ source: LEGAL }));
    const source = await planWorkflow({
      task: "audit routes",
      cwd: "/tmp",
      size: "medium",
      backend,
    });
    expect(source).toContain("await agent");
    expect(backend.starts[0]?.cliMode).toBe("plan");
    expect(backend.starts[0]?.tools).toBe("read");
  });

  it("falls back to a fenced script in the result string", async () => {
    const backend = new FakeWorkerBackend(
      () => `here\n\`\`\`javascript\n${LEGAL}\n\`\`\`\n`,
    );
    const source = await planWorkflow({
      task: "audit routes",
      cwd: "/tmp",
      size: "medium",
      backend,
    });
    expect(source).toContain("await agent");
  });

  it("rejects sandbox-illegal source", async () => {
    const backend = new FakeWorkerBackend(() => ({
      source: `export const meta = { name: "x" }\nrequire("fs")\nawait agent("x")\n`,
    }));
    await expect(
      planWorkflow({ task: "x", cwd: "/tmp", size: "small", backend }),
    ).rejects.toBeInstanceOf(WorkflowSandboxError);
  });
});
