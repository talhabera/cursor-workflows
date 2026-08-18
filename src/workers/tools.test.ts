import { describe, expect, it } from "vitest";
import { sdkToolConfig } from "./tools.js";

describe("sdkToolConfig", () => {
  it("maps read/write/full presets", () => {
    expect(sdkToolConfig("read").disallowedTools).toEqual(["shell", "edit", "task"]);
    expect(sdkToolConfig("write").disallowedTools).toEqual(["shell", "task"]);
    expect(sdkToolConfig("full").disallowedTools).toBeUndefined();
  });
});
