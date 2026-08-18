import { describe, expect, it } from "vitest";
import { parseIdFlags, parseRunFlags } from "./flags.js";
import { CliError } from "../errors.js";

describe("parseRunFlags", () => {
  it("parses a prompt and defaults", () => {
    const flags = parseRunFlags(["audit", "src/routes"]);
    expect(flags.prompt).toBe("audit src/routes");
    expect(flags.backend).toBe("cli");
    expect(flags.detach).toBe(false);
    expect(flags.size).toBe("medium");
    expect(flags.concurrency).toBe(4);
    expect(flags.yes).toBe(false);
  });

  it("parses --detach and --backend sdk", () => {
    const flags = parseRunFlags(["--detach", "--backend", "sdk", "--file", "wf.js"]);
    expect(flags.detach).toBe(true);
    expect(flags.backend).toBe("sdk");
    expect(flags.file).toBe("wf.js");
  });

  it("rejects a bad backend with an example invocation", () => {
    try {
      parseRunFlags(["--backend", "cloud"]);
      throw new Error("expected CliError");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).example).toContain("cw run --backend cli");
    }
  });
});

describe("parseIdFlags", () => {
  it("parses stop selectors", () => {
    const flags = parseIdFlags(["--run", "cw_1", "--phase", "verify", "--label", "src/a.ts"]);
    expect(flags.runId).toBe("cw_1");
    expect(flags.phase).toBe("verify");
    expect(flags.label).toBe("src/a.ts");
  });

  it("rejects an empty --phase value instead of silently treating it as whole-run", () => {
    try {
      parseIdFlags(["--run", "cw_1", "--phase", ""]);
      throw new Error("expected CliError");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).example).toContain("cw stop --run <id> --phase verify");
    }
  });

  it("rejects a whitespace-only --label value", () => {
    try {
      parseIdFlags(["--run", "cw_1", "--label", "   "]);
      throw new Error("expected CliError");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).example).toContain("cw stop --run <id> --phase verify");
    }
  });
});
