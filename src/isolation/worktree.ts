import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { CliError } from "../errors.js";

export async function createWorktree(options: {
  repoRoot: string;
  runId: string;
  label: string;
  index: number;
}): Promise<string> {
  const slug = sanitize(options.label || `agent-${options.index}`);
  const dir = path.join(
    options.repoRoot,
    ".cursor-workflows",
    "worktrees",
    options.runId,
    `${options.index}-${slug}`,
  );
  await mkdir(path.dirname(dir), { recursive: true });
  const branch = `cw/${options.runId}/${options.index}-${slug}`;
  try {
    await execa("git", ["worktree", "add", "-b", branch, dir, "HEAD"], {
      cwd: options.repoRoot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`failed to create git worktree: ${message}`, {
      example: "cw run --file <workflow.js>  (must be run inside a git repository)",
    });
  }
  return dir;
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await execa("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoRoot,
    });
  } catch {
    await rm(worktreePath, { recursive: true, force: true });
  }
}

function sanitize(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 40) || "item";
}

export function worktreeLabelHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 8);
}
