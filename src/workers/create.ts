import { DEFAULT_MODEL } from "../constants.js";
import { CliError } from "../errors.js";
import type { WorkerBackend, WorkerBackendName } from "../types.js";
import { assertNever } from "../util/assert-never.js";
import { CliWorkerBackend } from "./cli.js";
import { FakeWorkerBackend } from "./fake.js";
import { SdkWorkerBackend } from "./sdk.js";

export function createWorkerBackend(name: WorkerBackendName): WorkerBackend {
  switch (name) {
    case "fake":
      return new FakeWorkerBackend();
    case "sdk":
      return new SdkWorkerBackend({
        apiKey: process.env.CURSOR_API_KEY?.trim() ?? "",
        defaultModel: DEFAULT_MODEL,
      });
    case "cli":
      return new CliWorkerBackend({ defaultModel: DEFAULT_MODEL });
    default:
      return assertNever(name);
  }
}

export function requireApiKey(backend: WorkerBackendName): void {
  if (backend !== "sdk") {
    return;
  }
  if (!process.env.CURSOR_API_KEY?.trim()) {
    throw new CliError("CURSOR_API_KEY is not set", {
      example: 'export CURSOR_API_KEY="cursor_..." && cw run --backend sdk --file workflow.js --yes',
    });
  }
}
