import { describe, expect, it } from "vitest";
import { chatCommand } from "./chat.js";

describe("chatCommand", () => {
  it("execs agent with trust, MCP approval, plugin dir, and workspace", async () => {
    const calls: unknown[] = [];
    const code = await chatCommand(["--model", "composer-2.5"], {
      cwd: "/repo",
      pluginDir: "/pkg/plugin",
      agentBin: "agent",
      exec: async (file, args, options) => {
        calls.push({ file, args, options });
        return { exitCode: 0 };
      },
    });
    expect(code).toBe(0);
    const call = calls[0] as { file: string; args: string[]; options: { cwd: string; stdio: "inherit" } };
    expect(call.file).toBe("agent");
    expect(call.args).toEqual([
      "--trust",
      "--approve-mcps",
      "--plugin-dir",
      "/pkg/plugin",
      "--workspace",
      "/repo",
      "--model",
      "composer-2.5",
    ]);
    expect(call.options.stdio).toBe("inherit");
  });
});
