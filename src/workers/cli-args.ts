import type { WorkerRequest } from "../types.js";

export function buildCliAgentArgs(request: WorkerRequest, defaultModel: string): string[] {
  const args = [
    "-p",
    "--trust",
    "--approve-mcps",
    "--output-format",
    "json",
    "--workspace",
    request.cwd,
    "--model",
    request.model || defaultModel,
  ];
  if (request.tools === "write" || request.tools === "full") {
    args.push("--force");
  } else if (request.cliMode === "plan") {
    args.push("--mode", "plan");
  } else {
    args.push("--mode", "ask");
  }
  const prompt = request.schema
    ? `${request.prompt}\n\nReply with JSON only matching this schema:\n${JSON.stringify(request.schema)}`
    : request.prompt;
  args.push(prompt);
  return args;
}
