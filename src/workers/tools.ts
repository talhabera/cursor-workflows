import type { ToolName } from "@cursor/sdk";
import type { ToolPreset } from "../types.js";
import { assertNever } from "../util/assert-never.js";

export interface SdkToolConfig {
  tools: ToolName[] | undefined;
  disallowedTools: ToolName[] | undefined;
}

export function sdkToolConfig(preset: ToolPreset): SdkToolConfig {
  switch (preset) {
    case "read":
      return { tools: undefined, disallowedTools: ["shell", "edit", "task"] };
    case "write":
      return { tools: undefined, disallowedTools: ["shell", "task"] };
    case "full":
      return { tools: undefined, disallowedTools: undefined };
    default:
      return assertNever(preset);
  }
}

export function submitResultDescription(schema: Record<string, unknown> | undefined): string {
  if (!schema) {
    return "Submit the structured result of this task. Call this once when the answer is ready.";
  }
  return "Submit the structured result of this task. The arguments MUST match the provided JSON schema. Call this once when the answer is ready. Do not finish without calling submit_result.";
}
