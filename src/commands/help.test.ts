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
});
