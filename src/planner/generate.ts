import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, CursorAgentError, type SDKCustomToolResult, type SDKJsonValue } from "@cursor/sdk";
import { DEFAULT_MODEL } from "../constants.js";
import { CliError } from "../errors.js";
import { assertScriptAllowed } from "../runtime/sandbox.js";
import type { WorkflowSize } from "../types.js";
import { assertNever } from "../util/assert-never.js";
import { sdkToolConfig } from "../workers/tools.js";

export interface PlanWorkflowOptions {
  task: string;
  cwd: string;
  model?: string;
  size: WorkflowSize;
  apiKey: string;
}

export async function planWorkflow(options: PlanWorkflowOptions): Promise<string> {
  const prompt = await renderPlannerPrompt(options.task, options.size);
  let submitted: string | undefined;
  const toolConfig = sdkToolConfig("read");

  try {
    await using agent = await Agent.create({
      apiKey: options.apiKey,
      model: { id: options.model ?? DEFAULT_MODEL },
      ...(toolConfig.tools ? { tools: toolConfig.tools } : {}),
      ...(toolConfig.disallowedTools ? { disallowedTools: toolConfig.disallowedTools } : {}),
      local: {
        cwd: options.cwd,
        customTools: {
          submit_workflow: {
            description:
              "Submit the complete workflow.js source. Call this once when the script is ready. Do not implement the user task yourself.",
            inputSchema: {
              type: "object",
              required: ["source"],
              properties: {
                source: {
                  type: "string",
                  description: "Full JavaScript workflow source with export const meta and top-level await",
                },
              },
            },
            execute: (args: Record<string, SDKJsonValue>): SDKCustomToolResult => {
              const source = args.source;
              if (typeof source !== "string" || !source.trim()) {
                return {
                  content: [{ type: "text", text: "source must be a non-empty string" }],
                  isError: true,
                };
              }
              try {
                assertScriptAllowed(source);
              } catch (error) {
                return {
                  content: [
                    {
                      type: "text",
                      text: error instanceof Error ? error.message : String(error),
                    },
                  ],
                  isError: true,
                };
              }
              submitted = source.trim();
              return "ok";
            },
          },
        },
      },
    });

    const run = await agent.send(prompt);
    const result = await run.wait();

    switch (result.status) {
      case "finished": {
        const source = submitted ?? extractSourceFromText(result.result ?? "");
        if (!source) {
          throw new CliError("planner finished without producing a workflow script", {
            example: "cw run --file examples/audit-routes.js --yes",
          });
        }
        assertScriptAllowed(source);
        return source;
      }
      case "error":
        throw new CliError(`planner run failed: ${result.error?.message ?? result.id}`, {
          exitCode: 2,
          example: "cw run --file examples/audit-routes.js --yes",
        });
      case "cancelled":
        throw new CliError("planner run was cancelled", { exitCode: 2 });
      default: {
        const _exhaustive: never = result.status;
        throw new Error(`unexpected planner status: ${_exhaustive}`);
      }
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    if (error instanceof CursorAgentError) {
      throw new CliError(`planner failed to start: ${error.message}`, {
        example: 'export CURSOR_API_KEY="cursor_..." && cw run "your task" --yes',
      });
    }
    throw error;
  }
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
