import type { WorkerBackend, WorkerRequest, WorkerResult } from "../types.js";

export type FakeHandler = (request: WorkerRequest) => Promise<unknown> | unknown;

export class FakeWorkerBackend implements WorkerBackend {
  readonly name = "fake" as const;
  readonly starts: WorkerRequest[] = [];
  maxConcurrent = 0;
  private inFlight = 0;

  constructor(private readonly handler: FakeHandler = defaultFakeHandler) {}

  async start(request: WorkerRequest): Promise<WorkerResult> {
    if (request.signal.aborted) {
      return {
        id: "fake-cancelled",
        result: null,
        tokens: 0,
        transcriptPath: undefined,
        status: "cancelled",
      };
    }
    this.starts.push(request);
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    try {
      const result = await this.handler(request);
      return {
        id: `fake-${this.starts.length}`,
        result,
        tokens: 1,
        transcriptPath: undefined,
        status: "finished",
      };
    } catch (error) {
      return {
        id: `fake-${this.starts.length}`,
        result: error instanceof Error ? error.message : String(error),
        tokens: 1,
        transcriptPath: undefined,
        status: "error",
      };
    } finally {
      this.inFlight -= 1;
    }
  }
}

function defaultFakeHandler(request: WorkerRequest): unknown {
  if (request.schema) {
    return fakeFromSchema(request.schema, request.prompt);
  }
  return { echo: request.prompt, label: request.label ?? null };
}

function fakeFromSchema(schema: Record<string, unknown>, prompt: string): unknown {
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(properties)) {
      if (properties[key]?.type === "array") {
        out[key] = required.includes(key) ? [`${prompt}-item`] : [];
      } else if (properties[key]?.type === "number") {
        out[key] = 0;
      } else if (properties[key]?.type === "boolean") {
        out[key] = true;
      } else {
        out[key] = `${key} from: ${prompt}`;
      }
    }
    return out;
  }
  if (schema.type === "array") {
    return [prompt];
  }
  if (schema.type === "string") {
    return prompt;
  }
  return { echo: prompt };
}
