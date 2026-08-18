import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledPluginDir } from "./paths.js";

describe("bundledPluginDir", () => {
  it("resolves to an existing directory containing the bundled plugin manifest", () => {
    const dir = bundledPluginDir();
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(path.join(dir, ".cursor-plugin", "plugin.json"))).toBe(true);
  });

  it("resolves the same real plugin directory from a src/store/ module URL", () => {
    const from = pathToFileURL(path.join(process.cwd(), "src", "store", "paths.ts")).href;
    const dir = bundledPluginDir(from);
    expect(existsSync(path.join(dir, ".cursor-plugin", "plugin.json"))).toBe(true);
  });

  it("resolves the same real plugin directory from a dist/store/ module URL", () => {
    const from = pathToFileURL(path.join(process.cwd(), "dist", "store", "paths.js")).href;
    const dir = bundledPluginDir(from);
    expect(existsSync(path.join(dir, ".cursor-plugin", "plugin.json"))).toBe(true);
  });
});
