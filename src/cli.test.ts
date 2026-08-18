import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { runCli } from "./cli.js";

function memoryStream(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer | string) => chunks.push(String(chunk)));
  return { stream, text: () => chunks.join("") };
}

describe("runCli", () => {
  it("prints help on no command when stdin is not a TTY", async () => {
    const stdout = memoryStream();
    let chat = 0;
    const code = await runCli([], {
      stdout: stdout.stream,
      stderr: stdout.stream,
      stdinIsTTY: false,
      chat: async () => {
        chat += 1;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(chat).toBe(0);
    expect(stdout.text()).toContain("cw <command>");
  });

  it("starts chat on TTY with no command", async () => {
    let chat = 0;
    const stdout = memoryStream();
    const code = await runCli([], {
      stdout: stdout.stream,
      stderr: stdout.stream,
      stdinIsTTY: true,
      chat: async () => {
        chat += 1;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(chat).toBe(1);
  });

  it("never starts chat for --help", async () => {
    let chat = 0;
    const stdout = memoryStream();
    await runCli(["--help"], {
      stdout: stdout.stream,
      stderr: stdout.stream,
      stdinIsTTY: true,
      chat: async () => {
        chat += 1;
        return 0;
      },
    });
    expect(chat).toBe(0);
    expect(stdout.text()).toContain("Commands:");
  });
});
