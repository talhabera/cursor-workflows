import { execa } from "execa";
import { CliError } from "../errors.js";
import type { WorkerBackend, WorkerRequest, WorkerResult } from "../types.js";
import { validateJsonSchema } from "../runtime/schema.js";
import { buildCliAgentArgs } from "./cli-args.js";

export class CliWorkerBackend implements WorkerBackend {
  readonly name = "cli" as const;

  constructor(
    private readonly options: { defaultModel: string; agentBin?: string } = {
      defaultModel: "composer-2.5",
    },
  ) {}

  async start(request: WorkerRequest): Promise<WorkerResult> {
    const bin = (this.options.agentBin ?? process.env.CW_AGENT_BIN?.trim()) || "agent";
    const args = buildCliAgentArgs(request, this.options.defaultModel);

    try {
      const { stdout } = await execa(bin, args, {
        env: { ...process.env },
        cancelSignal: request.signal,
      });
      const parsed = parseAgentJson(stdout);
      let result: unknown = parsed.result;
      if (typeof result === "string") {
        result = parseMaybeJson(result);
      }
      if (request.schema) {
        const checked = validateJsonSchema(request.schema, result);
        if (!checked.ok) {
          return {
            id: parsed.id ?? "cli-worker",
            result: null,
            tokens: parsed.tokens,
            transcriptPath: undefined,
            status: "error",
          };
        }
      }
      return {
        id: parsed.id ?? "cli-worker",
        result,
        tokens: parsed.tokens,
        transcriptPath: undefined,
        status: parsed.isError ? "error" : "finished",
      };
    } catch (error) {
      if (request.signal.aborted) {
        return {
          id: "cli-cancelled",
          result: null,
          tokens: 0,
          transcriptPath: undefined,
          status: "cancelled",
        };
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CliError("agent CLI not found", {
          example: "agent login\n  Available: install Cursor Agent and ensure `agent` is on PATH (or set CW_AGENT_BIN)",
        });
      }
      if (/not logged in|unauthorized|login/i.test(String(error))) {
        throw new CliError("agent CLI is not logged in", { example: "agent login" });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError(`cursor CLI worker failed: ${message}`, {
        example: "agent -p --trust --output-format json --workspace <cwd> \"<prompt>\"",
      });
    }
  }
}

function parseAgentJson(stdout: string): { result: unknown; id?: string; tokens: number; isError: boolean } {
  const trimmed = stdout.trim();
  const lastLine = trimmed.split("\n").at(-1) ?? trimmed;
  try {
    const parsed = JSON.parse(lastLine) as {
      result?: unknown;
      id?: string;
      session_id?: string;
      is_error?: boolean;
      duration_ms?: number;
    };
    return {
      result: parsed.result ?? parsed,
      id: parsed.id ?? parsed.session_id,
      tokens: 0,
      isError: parsed.is_error === true,
    };
  } catch {
    return { result: trimmed, tokens: 0, isError: false };
  }
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
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
