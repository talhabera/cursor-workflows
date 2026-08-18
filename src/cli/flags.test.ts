import { describe, expect, it } from "vitest";
import { parseRunFlags } from "./flags.js";
import { CliError } from "../errors.js";

describe("parseRunFlags", () => {
  it("parses a prompt and defaults", () => {
    const flags = parseRunFlags(["audit", "src/routes"]);
    expect(flags.prompt).toBe("audit src/routes");
    expect(flags.backend).toBe("sdk");
    expect(flags.size).toBe("medium");
    expect(flags.concurrency).toBe(4);
    expect(flags.yes).toBe(false);
  });

  it("rejects a bad backend with an example invocation", () => {
    try {
      parseRunFlags(["--backend", "cloud"]);
      throw new Error("expected CliError");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).example).toContain("cw run --backend sdk");
    }
  });
});
