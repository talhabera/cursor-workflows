import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../errors.js";
import { requireApiKey } from "./create.js";

describe("requireApiKey", () => {
  const original = process.env.CURSOR_API_KEY;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CURSOR_API_KEY;
    } else {
      process.env.CURSOR_API_KEY = original;
    }
  });

  it("allows cli and fake without a key", () => {
    delete process.env.CURSOR_API_KEY;
    expect(() => requireApiKey("cli")).not.toThrow();
    expect(() => requireApiKey("fake")).not.toThrow();
  });

  it("requires a key for sdk", () => {
    delete process.env.CURSOR_API_KEY;
    try {
      requireApiKey("sdk");
      throw new Error("expected CliError");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).example).toContain("CURSOR_API_KEY");
    }
  });
});
