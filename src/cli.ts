#!/usr/bin/env node
import { chatCommand } from "./commands/chat.js";
import { ROOT_HELP } from "./commands/help.js";
import { resumeCommand } from "./commands/resume.js";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { stopCommand } from "./commands/stop.js";
import { workflowsCommand } from "./commands/workflows.js";
import { CliError, formatCliError } from "./errors.js";

export interface CliIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  stdinIsTTY?: boolean;
  chat?: (argv: string[]) => Promise<number>;
}

export async function runCli(argv: string[], io: CliIo = process): Promise<number> {
  const stdinIsTTY = io.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const startChat = io.chat ?? ((rest: string[]) => chatCommand(rest));
  const [command, ...rest] = argv;
  if (command === "-h" || command === "--help") {
    io.stdout.write(`${ROOT_HELP}\n`);
    return 0;
  }
  if (!command) {
    if (!stdinIsTTY) {
      io.stdout.write(`${ROOT_HELP}\n`);
      return 0;
    }
    return startChat([]);
  }
  if (command === "help") {
    if (rest[0]) {
      return dispatch(rest[0], ["--help"]);
    }
    io.stdout.write(`${ROOT_HELP}\n`);
    return 0;
  }
  if (command === "chat") {
    return startChat(rest);
  }
  return dispatch(command, rest);
}

async function dispatch(command: string, rest: string[]): Promise<number> {
  switch (command) {
    case "run":
      return runCommand(rest);
    case "workflows":
      return workflowsCommand(rest);
    case "status":
      return statusCommand(rest);
    case "stop":
      return stopCommand(rest);
    case "resume":
      return resumeCommand(rest);
    default:
      throw new CliError(`unknown command: ${command}`, {
        example: "cw run --file examples/audit-routes.js --yes",
      });
  }
}

async function main(): Promise<void> {
  try {
    const code = await runCli(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${formatCliError(error)}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1] ?? "";
const invokedDirectly =
  entry.endsWith("cli.ts") ||
  entry.endsWith("cli.js") ||
  entry.endsWith("/cw") ||
  entry.endsWith("\\cw");

if (invokedDirectly) {
  void main();
}
