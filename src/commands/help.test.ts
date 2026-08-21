import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROOT_HELP, RUN_HELP, WATCH_HELP } from "./help.js";

describe("help copy", () => {
  it("treats cli as the default backend and documents detach", () => {
    expect(RUN_HELP).toContain("default: cli");
    expect(RUN_HELP).toContain("--detach");
    expect(RUN_HELP).toContain("agent login");
    expect(ROOT_HELP).toContain("cw chat");
  });

  it("documents cw watch", () => {
    expect(ROOT_HELP).toContain("watch");
    expect(WATCH_HELP).toContain("cw watch [--run <id>] [--timeout 300]");
    expect(WATCH_HELP).toContain("cw watch --run cw_k1_ab12 --timeout 300 --output json");
  });

  it("README documents automatic phase summaries and cw watch", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const readme = await readFile(path.join(root, "README.md"), "utf8");
    expect(readme).toContain("cw watch");
    expect(readme.toLowerCase()).toContain("phase summary");
  });
});
