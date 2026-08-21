import { describe, expect, it } from "vitest";
import { buildCliAgentArgs } from "./cli-args.js";
import type { WorkerRequest } from "../types.js";

function request(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    prompt: "do work",
    cwd: "/repo",
    model: "composer-2.5",
    tools: "read",
    schema: undefined,
    label: undefined,
    phase: undefined,
    isolation: "cwd",
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("buildCliAgentArgs", () => {
  it("uses ask mode for read workers and never --force", () => {
    const args = buildCliAgentArgs(request(), "composer-2.5");
    expect(args.slice(0, 8)).toEqual([
      "-p",
      "--trust",
      "--approve-mcps",
      "--output-format",
      "json",
      "--workspace",
      "/repo",
      "--model",
    ]);
    expect(args).toContain("--mode");
    expect(args).toContain("ask");
    expect(args).not.toContain("--force");
    expect(args.at(-1)).toBe("do work");
  });

  it("uses plan mode when cliMode is plan", () => {
    const args = buildCliAgentArgs(request({ cliMode: "plan" }), "composer-2.5");
    expect(args).toContain("plan");
    expect(args).not.toContain("ask");
    expect(args).not.toContain("--force");
  });

  it("passes --force for write and full", () => {
    for (const tools of ["write", "full"] as const) {
      const args = buildCliAgentArgs(request({ tools, cliMode: "plan" }), "composer-2.5");
      expect(args).toContain("--force");
      expect(args).not.toContain("--mode");
    }
  });

  it("appends a JSON schema instruction", () => {
    const args = buildCliAgentArgs(
      request({ schema: { type: "object", required: ["source"], properties: { source: { type: "string" } } } }),
      "composer-2.5",
    );
    expect(String(args.at(-1))).toContain("Reply with JSON only matching this schema");
    expect(String(args.at(-1))).toContain('"source"');
  });
});
