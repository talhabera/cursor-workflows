import { Agent, CursorAgentError, type SDKCustomToolResult, type SDKJsonValue } from "@cursor/sdk";
import { CliError } from "../errors.js";
import type { WorkerBackend, WorkerRequest, WorkerResult } from "../types.js";
import { jsonSchemaToToolInput, unwrapToolResult, validateJsonSchema } from "../runtime/schema.js";
import { sdkToolConfig, submitResultDescription } from "./tools.js";

export interface SdkWorkerOptions {
  apiKey: string;
  defaultModel: string;
}

export class SdkWorkerBackend implements WorkerBackend {
  readonly name = "sdk" as const;

  constructor(private readonly options: SdkWorkerOptions) {}

  async start(request: WorkerRequest): Promise<WorkerResult> {
    if (!this.options.apiKey) {
      throw new CliError("CURSOR_API_KEY is not set", {
        example: 'export CURSOR_API_KEY="cursor_..." && cw run --file workflow.js --yes',
      });
    }

    let submitted: unknown;
    let submittedValid = false;
    const toolConfig = sdkToolConfig(request.tools);
    const schema = request.schema;
    const inputSchema = schema ? jsonSchemaToToolInput(schema) : { type: "object", additionalProperties: true };

    try {
      await using agent = await Agent.create({
        apiKey: this.options.apiKey,
        model: { id: request.model || this.options.defaultModel },
        ...(toolConfig.tools ? { tools: toolConfig.tools } : {}),
        ...(toolConfig.disallowedTools ? { disallowedTools: toolConfig.disallowedTools } : {}),
        local: {
          cwd: request.cwd,
          customTools: {
            submit_result: {
              description: submitResultDescription(schema),
              inputSchema: inputSchema as Record<string, SDKJsonValue>,
              execute: (args: Record<string, SDKJsonValue>): SDKCustomToolResult => {
                const payload = schema ? unwrapToolResult(schema, args) : args;
                if (schema) {
                  const checked = validateJsonSchema(schema, payload);
                  if (!checked.ok) {
                    return {
                      content: [{ type: "text", text: `Invalid result: ${checked.errors}` }],
                      isError: true,
                    };
                  }
                }
                submitted = payload;
                submittedValid = true;
                return "ok";
              },
            },
          },
        },
      });

      const prompt = schema
        ? `${request.prompt}\n\nWhen finished, call submit_result with arguments matching this JSON schema:\n${JSON.stringify(schema)}`
        : `${request.prompt}\n\nWhen finished, call submit_result with your structured answer.`;

      const run = await agent.send(prompt);
      const onAbort = (): void => {
        void run.cancel();
      };
      if (request.signal.aborted) {
        onAbort();
      } else {
        request.signal.addEventListener("abort", onAbort);
      }
      let result: Awaited<ReturnType<typeof run.wait>>;
      try {
        result = await run.wait();
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }

      switch (result.status) {
        case "finished": {
          const value = submittedValid
            ? submitted
            : parseMaybeJson(result.result ?? "");
          return {
            id: result.id,
            result: value,
            tokens: result.usage?.totalTokens ?? 0,
            transcriptPath: undefined,
            status: "finished",
          };
        }
        case "error":
          return {
            id: result.id,
            result: result.error?.message ?? result.result ?? null,
            tokens: result.usage?.totalTokens ?? 0,
            transcriptPath: undefined,
            status: "error",
          };
        case "cancelled":
          return {
            id: result.id,
            result: null,
            tokens: result.usage?.totalTokens ?? 0,
            transcriptPath: undefined,
            status: "cancelled",
          };
        default: {
          const _exhaustive: never = result.status;
          throw new Error(`unexpected run status: ${_exhaustive}`);
        }
      }
    } catch (error) {
      if (error instanceof CursorAgentError) {
        return {
          id: "sdk-startup",
          result: error.message,
          tokens: 0,
          transcriptPath: undefined,
          status: "error",
        };
      }
      throw error;
    }
  }
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence?.[1]) {
      try {
        return JSON.parse(fence[1].trim()) as unknown;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
}
