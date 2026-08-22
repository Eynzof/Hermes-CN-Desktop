import { runExecutor, type ExecutorContext } from "../executors";
import { gatewayHelpLines, listCommands } from "../registry";
import type { CommandResult, LocalHandlerContext } from "../types";

function ok(output: string, extras?: Partial<CommandResult>): CommandResult {
  return { type: "exec", output, ...extras };
}

function err(message: string): CommandResult {
  return { type: "error", message };
}

export function handleVersion(args: string, ctx: LocalHandlerContext): CommandResult {
  const reply = runExecutor("version", {
    args,
    buildInfo: ctx.getBuildInfo?.(),
  });
  return ok(reply.text, { output: reply.text });
}

export function handleEgress(args: string, ctx: LocalHandlerContext): CommandResult {
  const reply = runExecutor("egress", {
    args,
    status: ctx.getStatus?.(),
  });
  return ok(reply.text, { output: reply.text });
}

export function handleHelp(args: string): CommandResult {
  const reply = runExecutor("gateway_help", {
    args,
    commands: gatewayHelpLines().map((c) => ({
      name: c.name.replace(/^\//, ""),
      description: c.description,
      category: c.category,
    })),
  });
  return ok(reply.text, { output: reply.text });
}

export function handleCommands(args: string): CommandResult {
  const reply = runExecutor("gateway_commands", {
    args,
    commands: listCommands()
      .filter((c) => !c.gatewayOnly && !c.cliOnly)
      .map((c) => ({
        name: c.name,
        description: c.description,
        category: c.category,
      })),
  });
  return ok(reply.text, { output: reply.text });
}

export function handleProfile(args: string, ctx: LocalHandlerContext): CommandResult {
  const buildInfo = ctx.getBuildInfo?.();
  const reply = runExecutor("profile", {
    args,
    activeProfile: buildInfo?.activeProfile,
    profiles: buildInfo?.profiles,
  });
  return ok(reply.text, { output: reply.text });
}

export function handleBundles(args: string, ctx: LocalHandlerContext): CommandResult {
  const buildInfo = ctx.getBuildInfo?.();
  const reply = runExecutor("bundles", {
    args,
    bundles: buildInfo?.bundles,
  });
  return ok(reply.text, { output: reply.text });
}
