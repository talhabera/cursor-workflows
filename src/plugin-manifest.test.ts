import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("bundled plugin", () => {
  it("declares the orchestrator skill", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(root, "plugin/.cursor-plugin/plugin.json"), "utf8"),
    ) as { name: string; skills: string; hooks: string };
    expect(manifest.name).toBe("cursor-workflows");
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.hooks).toBe("./hooks/hooks.json");
    const skill = await readFile(path.join(root, "plugin/skills/cw-orchestrator/SKILL.md"), "utf8");
    expect(skill).toContain("cw run");
    expect(skill).toContain("--detach");
    expect(skill).toContain("cw stop --run");
    expect(skill).not.toContain("submit_workflow");
    expect(skill.toLowerCase()).toContain("agent login");
    expect(skill).toContain("[cw-watch]");
    expect(skill).toContain("phase summary");
    expect(skill).not.toContain("sleep 300");
    expect(skill.toLowerCase()).not.toContain("only status when asked");
  });

  it("ships a stop hook that watches runs", async () => {
    const hooks = JSON.parse(
      await readFile(path.join(root, "plugin/hooks/hooks.json"), "utf8"),
    ) as {
      version: number;
      hooks: { stop: Array<{ command: string; timeout: number; loop_limit: number | null }> };
    };
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.stop[0]?.command).toBe("node ./hooks/orchestrator-stop.js");
    expect(hooks.hooks.stop[0]?.timeout).toBe(330);
    expect(hooks.hooks.stop[0]?.loop_limit).toBe(80);
    const script = await readFile(path.join(root, "plugin/hooks/orchestrator-stop.js"), "utf8");
    expect(script).toContain("runOrchestratorStopHook");
    expect(script).toContain("../../dist/hooks/orchestrator-stop.js");
  });
});
