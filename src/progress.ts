import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { OutputFormat, RunEvent } from "./types.js";

export interface ProgressSink {
  emit(event: RunEvent): Promise<void>;
}

export function createProgressSink(options: {
  eventsPath: string;
  format: OutputFormat;
  stderr?: { write(chunk: string): unknown; isTTY?: boolean };
}): ProgressSink {
  const stderr = options.stderr ?? process.stderr;
  let line = "";
  const phases = new Map<string, { done: number; started: number }>();
  let tokens = 0;
  let agents = 0;

  return {
    async emit(event: RunEvent): Promise<void> {
      await mkdir(path.dirname(options.eventsPath), { recursive: true });
      await appendFile(options.eventsPath, `${JSON.stringify(event)}\n`, "utf8");

      switch (event.type) {
        case "agent_start": {
          agents += 1;
          if (event.phase) {
            const current = phases.get(event.phase) ?? { done: 0, started: 0 };
            current.started += 1;
            phases.set(event.phase, current);
          }
          line = formatLine(phases, agents, tokens);
          write(stderr, options.format, line, event);
          return;
        }
        case "agent_end": {
          tokens += event.tokens;
          if (event.phase) {
            const current = phases.get(event.phase) ?? { done: 0, started: 0 };
            current.done += 1;
            phases.set(event.phase, current);
          }
          line = formatLine(phases, agents, tokens);
          write(stderr, options.format, line, event);
          return;
        }
        case "warning":
          stderr.write(`warning: ${event.message}\n`);
          return;
        case "status":
          if (options.format === "json") {
            stderr.write(`${JSON.stringify(event)}\n`);
          }
          return;
        case "result":
          return;
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    },
  };
}

function formatLine(
  phases: Map<string, { done: number; started: number }>,
  agents: number,
  tokens: number,
): string {
  const phaseText =
    phases.size === 0
      ? `agents ${agents}`
      : [...phases.entries()]
          .map(([name, counts]) => `${name} ${counts.done}/${counts.started}`)
          .join(" · ");
  return `${phaseText} · tokens ${tokens}`;
}

function write(
  stderr: { write(chunk: string): unknown; isTTY?: boolean },
  format: OutputFormat,
  line: string,
  event: RunEvent,
): void {
  if (format === "json") {
    stderr.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (stderr.isTTY) {
    stderr.write(`\r${line}`);
    return;
  }
  stderr.write(`${line}\n`);
}
