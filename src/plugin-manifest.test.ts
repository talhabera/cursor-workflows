import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("bundled plugin", () => {
  it("declares the orchestrator skill", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(root, "plugin/.cursor-plugin/plugin.json"), "utf8"),
    ) as { name: string; skills: string };
    expect(manifest.name).toBe("cursor-workflows");
    expect(manifest.skills).toBe("./skills/");
    const skill = await readFile(path.join(root, "plugin/skills/cw-orchestrator/SKILL.md"), "utf8");
    expect(skill).toContain("cw run");
    expect(skill).toContain("--detach");
    expect(skill).toContain("cw stop --run");
    expect(skill).not.toContain("submit_workflow");
    expect(skill.toLowerCase()).toContain("agent login");
  });
});
