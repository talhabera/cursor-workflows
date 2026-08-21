import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowSandboxError } from "../errors.js";
import { extractSourceFromText, planWorkflow } from "./generate.js";
import { FakeWorkerBackend } from "../workers/fake.js";
import { CliWorkerBackend } from "../workers/cli.js";

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

  it("accepts a fenced javascript reply through the real CLI parsing path (no schema validation nulling it out)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cw-planner-cli-"));
    const scriptPath = path.join(dir, "agent-stub.sh");
    const dataPath = path.join(dir, "reply.json");
    const fencedReply = `Here is the workflow:\n\`\`\`javascript\n${LEGAL}\`\`\`\n`;
    await writeFile(dataPath, JSON.stringify({ result: fencedReply, is_error: false }), "utf8");
    await writeFile(scriptPath, `#!/bin/sh\ncat "${dataPath}"\n`, "utf8");
    await chmod(scriptPath, 0o755);
    try {
      const backend = new CliWorkerBackend({ defaultModel: "composer-2.5", agentBin: scriptPath });
      const source = await planWorkflow({
        task: "audit routes",
        cwd: "/tmp",
        size: "medium",
        backend,
      });
      expect(source).toContain("await agent");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
