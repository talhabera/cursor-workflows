import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundledPluginDir } from "./paths.js";

describe("bundledPluginDir", () => {
  it("resolves to the package plugin directory", () => {
    expect(path.basename(bundledPluginDir())).toBe("plugin");
  });
});
