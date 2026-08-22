import type { CommandResult, LocalHandlerContext } from "../types.js";

export function handleProfile(args: string, ctx: LocalHandlerContext): CommandResult {
  const name = args.trim();
  if (!name) {
    return {
      type: "exec",
      output: `Active profile: ${ctx.getBuildInfo?.()?.activeProfile ?? "default"}`,
    };
  }
  return {
    type: "exec",
    output: `Profile switch to '${name}' requires Rust IPC (stub)`,
  };
}
