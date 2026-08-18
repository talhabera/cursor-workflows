import { describe, expect, it } from "vitest";
import { ROOT_HELP, RUN_HELP } from "./help.js";

describe("help copy", () => {
  it("treats cli as the default backend and documents detach", () => {
    expect(RUN_HELP).toContain("default: cli");
    expect(RUN_HELP).toContain("--detach");
    expect(RUN_HELP).toContain("agent login");
    expect(ROOT_HELP).toContain("cw chat");
  });
});
