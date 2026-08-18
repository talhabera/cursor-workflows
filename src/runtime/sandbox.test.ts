import { describe, expect, it } from "vitest";
import { WorkflowSandboxError } from "../errors.js";
import {
  assertScriptAllowed,
  extractMeta,
  transformWorkflowSource,
} from "./sandbox.js";

describe("workflow sandbox", () => {
  it("rejects import()", () => {
    expect(() => assertScriptAllowed('const x = await import("fs")')).toThrow(
      WorkflowSandboxError,
    );
  });

  it("rejects require and process", () => {
    expect(() => assertScriptAllowed('require("fs")')).toThrow(WorkflowSandboxError);
    expect(() => assertScriptAllowed("process.exit(1)")).toThrow(WorkflowSandboxError);
  });

  it("strips export const meta and wraps an async body", () => {
    const source = `export const meta = { name: "demo", description: "d" }
return 1
`;
    const transformed = transformWorkflowSource(source);
    expect(transformed).toContain("const meta =");
    expect(transformed).not.toContain("export const");
    expect(transformed).toContain("__resolve");
  });

  it("extracts meta from the source text", () => {
    expect(
      extractMeta(`export const meta = { name: "audit-routes", description: "Audit routes" }`),
    ).toEqual({ name: "audit-routes", description: "Audit routes" });
  });
});
