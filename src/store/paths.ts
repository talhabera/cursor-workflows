import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_WORKFLOWS_DIR, RUN_DIR_NAME, USER_WORKFLOWS_DIR_SEGMENTS } from "../constants.js";

export function runRoot(cwd: string): string {
  return path.join(cwd, RUN_DIR_NAME, "runs");
}

export function runDir(cwd: string, runId: string): string {
  return path.join(runRoot(cwd), runId);
}

export function runFile(cwd: string, runId: string, name: string): string {
  return path.join(runDir(cwd, runId), name);
}

export function projectWorkflowsDir(cwd: string): string {
  return path.join(cwd, PROJECT_WORKFLOWS_DIR);
}

export function userWorkflowsDir(home: string = homedir()): string {
  return path.join(home, ...USER_WORKFLOWS_DIR_SEGMENTS);
}

export function bundledPluginDir(from: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(from)), "../plugin");
}
