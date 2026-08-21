import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL } from "../constants.js";
import { CliError } from "../errors.js";
import { assertScriptAllowed } from "../runtime/sandbox.js";
import type { WorkerBackend, WorkflowSize } from "../types.js";
import { assertNever } from "../util/assert-never.js";

export const PLANNER_SOURCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["source"],
  properties: {
    source: { type: "string", description: "Full JavaScript workflow source" },
  },
};

export interface PlanWorkflowOptions {
  task: string;
  cwd: string;
  model?: string;
  size: WorkflowSize;
  backend: WorkerBackend;
  signal?: AbortSignal;
}

export async function planWorkflow(options: PlanWorkflowOptions): Promise<string> {
  const prompt = await renderPlannerPrompt(options.task, options.size);
  const workerResult = await options.backend.start({
    prompt,
    cwd: options.cwd,
    model: options.model ?? DEFAULT_MODEL,
    tools: "read",
    cliMode: "plan",
    schema: undefined,
    label: "planner",
    phase: "plan",
    isolation: "cwd",
    signal: options.signal ?? new AbortController().signal,
  });
  const source = sourceFromResult(workerResult.result);
  if (!source || workerResult.status !== "finished") {
    throw new CliError("planner finished without producing a workflow script", {
      example: "cw run --file examples/audit-routes.js --yes",
    });
  }
  assertScriptAllowed(source);
  return source;
}

function sourceFromResult(result: unknown): string | undefined {
  if (result && typeof result === "object" && "source" in result) {
    const source = (result as { source: unknown }).source;
    if (typeof source === "string" && source.trim()) {
      return source.trim();
    }
  }
  if (typeof result === "string") {
    return extractSourceFromText(result);
  }
  return undefined;
}

export async function renderPlannerPrompt(task: string, size: WorkflowSize): Promise<string> {
  const template = await readPlannerTemplate();
  return template
    .replaceAll("{{SIZE_GUIDELINE}}", sizeGuideline(size))
    .replaceAll("{{TASK}}", task);
}

async function readPlannerTemplate(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "prompts", "generate-workflow.md"),
    path.join(here, "../../src/planner/prompts/generate-workflow.md"),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new Error("planner prompt template not found");
}

function sizeGuideline(size: WorkflowSize): string {
  switch (size) {
    case "small":
      return "Aim for fewer than 5 agent() calls.";
    case "medium":
      return "Aim for fewer than 15 agent() calls. This is the default.";
    case "large":
      return "Aim for fewer than 50 agent() calls.";
    case "unrestricted":
      return "Size the workflow to the task. The runtime still caps total agents.";
    default:
      return assertNever(size);
  }
}

export function extractSourceFromText(text: string): string | undefined {
  const fence = text.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
  if (fence?.[1]?.includes("agent(")) {
    return fence[1].trim();
  }
  if (text.includes("export const meta") && text.includes("agent(")) {
    return text.trim();
  }
  return undefined;
}
