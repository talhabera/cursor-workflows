import { describe, expect, it } from "vitest";
import { extractSourceFromText } from "./generate.js";

describe("extractSourceFromText", () => {
  it("reads a javascript fence that contains agent()", () => {
    const text = "Here is the script:\n```javascript\nexport const meta = { name: \"x\" }\nawait agent(\"hi\")\n```\n";
    expect(extractSourceFromText(text)).toContain("await agent");
  });
});
