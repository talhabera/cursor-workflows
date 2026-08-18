import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCommand } from "./run.js";
import { statusCommand } from "./status.js";
import { workflowsCommand } from "./workflows.js";

function memoryStream(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer | string) => {
    chunks.push(String(chunk));
  });
  return { stream, text: () => chunks.join("") };
}

describe("cw run with fake backend", () => {
  it("executes a file workflow and records status", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "cw-"));
    const file = path.join(cwd, "wf.js");
    await writeFile(
      file,
      `export const meta = { name: "demo", description: "demo" }
const found = await agent("list", {
  schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
  phase: "discover",
})
const out = await pipeline(found.files, (file) => agent("audit " + file, { label: file, phase: "audit" }))
return out
`,
      "utf8",
    );

    const stdout = memoryStream();
    const stderr = memoryStream();
    const code = await runCommand(
      ["--file", file, "--cwd", cwd, "--backend", "fake", "--yes", "--save", "--output", "json"],
      { stdout: stdout.stream, stderr: stderr.stream },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.text()) as { result: unknown; meta: { name: string } };
    expect(payload.meta.name).toBe("demo");
    expect(Array.isArray(payload.result)).toBe(true);

    const statusOut = memoryStream();
    await statusCommand(["--output", "json"], { stdout: statusOut.stream, stderr: stderr.stream }, cwd);
    const status = JSON.parse(statusOut.text()) as { status: string; backend: string };
    expect(status.status).toBe("completed");
    expect(status.backend).toBe("fake");

    const listOut = memoryStream();
    await workflowsCommand(["list"], { stdout: listOut.stream, stderr: stderr.stream }, cwd);
    expect(listOut.text()).toContain("demo");

    await rm(cwd, { recursive: true, force: true });
  });
});
