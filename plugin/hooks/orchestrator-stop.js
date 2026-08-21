import { readFileSync } from "node:fs";
import { runOrchestratorStopHook } from "../../dist/hooks/orchestrator-stop.js";

let raw = "{}";
try {
  raw = readFileSync(0, "utf8") || "{}";
} catch {
  raw = "{}";
}

let input = {};
try {
  input = JSON.parse(raw);
} catch {
  process.stdout.write("{}\n");
  process.exit(0);
}

await runOrchestratorStopHook(input);
