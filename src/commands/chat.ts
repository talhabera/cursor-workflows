import { execa } from "execa";
import { CliError } from "../errors.js";
import { bundledPluginDir } from "../store/paths.js";

export interface ChatHooks {
  cwd?: string;
  pluginDir?: string;
  agentBin?: string;
  exec?: (
    file: string,
    args: string[],
    options: { cwd: string; stdio: "inherit" },
  ) => Promise<{ exitCode?: number | null; code?: string; failed?: boolean }>;
}

export async function chatCommand(argv: string[], hooks: ChatHooks = {}): Promise<number> {
  const cwd = hooks.cwd ?? process.cwd();
  const bin = hooks.agentBin ?? (process.env.CW_AGENT_BIN?.trim() || "agent");
  const pluginDir = hooks.pluginDir ?? bundledPluginDir();
  const args = [
    "--trust",
    "--approve-mcps",
    "--plugin-dir",
    pluginDir,
    "--workspace",
    cwd,
    ...argv,
  ];
  try {
    const exec =
      hooks.exec ??
      ((file, execArgs, options) => execa(file, execArgs, { ...options, reject: false }));
    const result = await exec(bin, args, { cwd, stdio: "inherit" });
    if (result.failed && result.code === "ENOENT") {
      throw new CliError("agent CLI not found", {
        example: "agent login\n  Available: install Cursor Agent and ensure `agent` is on PATH (or set CW_AGENT_BIN)",
      });
    }
    if (result.exitCode == null) {
      return result.failed ? 1 : 0;
    }
    return result.exitCode;
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CliError("agent CLI not found", {
        example: "agent login\n  Available: install Cursor Agent and ensure `agent` is on PATH (or set CW_AGENT_BIN)",
      });
    }
    throw error;
  }
}
