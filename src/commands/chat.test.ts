import { describe, expect, it } from "vitest";
import { chatCommand } from "./chat.js";
import { CliError } from "../errors.js";

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

  it("returns agent non-zero exit codes without throwing", async () => {
    const code = await chatCommand([], {
      exec: async () => ({ exitCode: 2 }),
    });
    expect(code).toBe(2);
  });

  it("throws a CliError when the resolved exec result reports ENOENT (execa reject: false semantics)", async () => {
    await expect(
      chatCommand([], {
        exec: async () =>
          ({ exitCode: undefined, code: "ENOENT", failed: true }) as { exitCode?: number | null },
      }),
    ).rejects.toBeInstanceOf(CliError);

    try {
      await chatCommand([], {
        exec: async () =>
          ({ exitCode: undefined, code: "ENOENT", failed: true }) as { exitCode?: number | null },
      });
      throw new Error("expected CliError");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toBe("agent CLI not found");
      expect((error as CliError).example).toContain("agent login");
      expect((error as CliError).example).toContain("CW_AGENT_BIN");
    }
  });

  it("returns a non-zero code for a resolved failure that is not ENOENT", async () => {
    const code = await chatCommand([], {
      exec: async () =>
        ({ exitCode: undefined, code: "EACCES", failed: true }) as { exitCode?: number | null },
    });
    expect(code).not.toBe(0);
  });
});
