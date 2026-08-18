import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../errors.js";
import { extractMeta } from "../runtime/sandbox.js";
import type { WorkflowMeta } from "../types.js";
import { projectWorkflowsDir, userWorkflowsDir } from "./paths.js";

export interface SavedWorkflow {
  name: string;
  path: string;
  scope: "project" | "user";
  meta: WorkflowMeta;
}

export async function loadWorkflowByName(cwd: string, name: string): Promise<string> {
  const fileName = name.endsWith(".js") ? name : `${name}.js`;
  const projectPath = path.join(projectWorkflowsDir(cwd), fileName);
  const userPath = path.join(userWorkflowsDir(), fileName);
  try {
    return await readFile(projectPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    return await readFile(userPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError(`workflow not found: ${name}`, {
        example: `cw run --workflow ${name.replace(/\.js$/, "")} --yes`,
      });
    }
    throw error;
  }
}

export async function saveWorkflow(
  cwd: string,
  source: string,
  options: { name?: string; scope?: "project" | "user" } = {},
): Promise<string> {
  const meta = extractMeta(source);
  const name = options.name ?? meta.name;
  if (!name) {
    throw new CliError("cannot save workflow without a name", {
      example: "cw run --file workflow.js --save --yes",
    });
  }
  const dir =
    options.scope === "user" ? userWorkflowsDir() : projectWorkflowsDir(cwd);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.js`);
  await writeFile(filePath, source.endsWith("\n") ? source : `${source}\n`, "utf8");
  return filePath;
}

export async function listSavedWorkflows(cwd: string): Promise<SavedWorkflow[]> {
  const project = await listDir(projectWorkflowsDir(cwd), "project");
  const user = await listDir(userWorkflowsDir(), "user");
  const byName = new Map<string, SavedWorkflow>();
  for (const item of user) {
    byName.set(item.name, item);
  }
  for (const item of project) {
    byName.set(item.name, item);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function listDir(dir: string, scope: "project" | "user"): Promise<SavedWorkflow[]> {
  try {
    const names = await readdir(dir);
    const items: SavedWorkflow[] = [];
    for (const name of names) {
      if (!name.endsWith(".js")) {
        continue;
      }
      const filePath = path.join(dir, name);
      const source = await readFile(filePath, "utf8");
      items.push({
        name: name.replace(/\.js$/, ""),
        path: filePath,
        scope,
        meta: extractMeta(source),
      });
    }
    return items;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
