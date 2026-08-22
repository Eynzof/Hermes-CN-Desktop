/**
 * In-process `/tools` and `/toolsets` slash command handlers.
 *
 * These mirror the Core `hermes tools [list|enable|disable]` CLI surface and
 * can be registered in the composer palette alongside built-in commands.
 */

import {
  disableToolset,
  enableToolset,
  getPlatformTools,
  getAllToolsetKeys,
  TOOLSETS,
  upsertCustomToolset,
  deleteCustomToolset,
  type ToolConfigLike,
  type CustomToolset,
} from "@hermes/agent-tools";

export type ToolsSubcommand = "list" | "enable" | "disable";
export type ToolsetsSubcommand = "list" | "enable" | "disable" | "create" | "delete";

export interface ToolsCommandResult {
  ok: boolean;
  message: string;
  config: ToolConfigLike;
}

export function parseToolsArgs(text: string): { subcommand: ToolsSubcommand; names: string[] } | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const subcommand = tokens[0] as ToolsSubcommand;
  if (!["list", "enable", "disable"].includes(subcommand)) return null;
  return { subcommand, names: tokens.slice(1) };
}

export function parseToolsetsArgs(
  text: string,
): { subcommand: ToolsetsSubcommand; name?: string; tools?: string[]; includes?: string[]; description?: string } | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const subcommand = tokens[0] as ToolsetsSubcommand;
  if (!["list", "enable", "disable", "create", "delete"].includes(subcommand)) return null;

  if (subcommand === "create") {
    // /toolsets create name tool1,tool2 includes=toolset1,toolset2 desc=text
    const name = tokens[1];
    if (!name) return null;
    const raw = tokens.slice(2).join(" ");
    const toolsMatch = raw.match(/tools=([^\s]+)/);
    const includesMatch = raw.match(/includes=([^\s]+)/);
    const descMatch = raw.match(/desc="([^"]+)"/);
    return {
      subcommand,
      name,
      tools: toolsMatch ? toolsMatch[1].split(",") : [],
      includes: includesMatch ? includesMatch[1].split(",") : [],
      description: descMatch ? descMatch[1] : "",
    };
  }

  if (subcommand === "delete") {
    return { subcommand, name: tokens[1] };
  }

  return { subcommand, name: tokens[1], tools: tokens.slice(2) };
}

export function handleToolsCommand(
  config: ToolConfigLike,
  platform: string,
  text: string,
): ToolsCommandResult {
  const parsed = parseToolsArgs(text);
  if (!parsed) return { ok: false, message: "用法: /tools list|enable|disable <name...>", config };

  const { subcommand, names } = parsed;
  const current = getPlatformTools(config, platform);

  if (subcommand === "list") {
    return {
      ok: true,
      message: `已启用 toolsets (${platform}): ${current.enabled.join(", ") || "(none)"}`,
      config,
    };
  }

  if (names.length === 0) {
    return { ok: false, message: `请提供要${subcommand}的 toolset 名称`, config };
  }

  let next = config;
  for (const name of names) {
    next = subcommand === "enable" ? enableToolset(next, platform, name) : disableToolset(next, platform, name);
  }
  return {
    ok: true,
    message: `已${subcommand}: ${names.join(", ")}`,
    config: next,
  };
}

export function handleToolsetsCommand(
  config: ToolConfigLike,
  platform: string,
  text: string,
): ToolsCommandResult {
  const parsed = parseToolsetsArgs(text);
  if (!parsed) return { ok: false, message: "用法: /toolsets list|enable|disable|create|delete ...", config };

  const { subcommand, name, tools, includes, description } = parsed;

  if (subcommand === "list") {
    const keys = getAllToolsetKeys({ customToolsets: config.custom_toolsets });
    const custom = Object.keys(config.custom_toolsets ?? {});
    return {
      ok: true,
      message: `已知 toolsets: ${keys.join(", ")}${custom.length ? `；自定义: ${custom.join(", ")}` : ""}`,
      config,
    };
  }

  if (subcommand === "create") {
    if (!name) {
      return { ok: false, message: "请提供自定义 toolset 名称", config };
    }
    const def: CustomToolset = {
      name,
      tools: tools ?? [],
      includes: includes ?? [],
      description: description ?? "",
    };
    const next = upsertCustomToolset(config, def);
    return { ok: true, message: `已创建自定义 toolset: ${name}`, config: next };
  }

  if (subcommand === "delete") {
    if (!name) {
      return { ok: false, message: "请提供要删除的自定义 toolset 名称", config };
    }
    const next = deleteCustomToolset(config, name);
    return { ok: true, message: `已删除自定义 toolset: ${name}`, config: next };
  }

  if (!name) {
    return { ok: false, message: `请提供要${subcommand}的 toolset 名称`, config };
  }

  const current = getPlatformTools(config, platform);
  let next = config;
  next = subcommand === "enable" ? enableToolset(next, platform, name) : disableToolset(next, platform, name);
  return {
    ok: true,
    message: `已${subcommand} toolset: ${name}`,
    config: next,
  };
}

/** Composer palette metadata for `/tools` and `/toolsets`. */
export interface ComposerToolCommandCandidate {
  token: string;
  command: string;
  displayName: string;
  description: string;
  kind: "namespace" | "builtin";
}

export function getToolComposerCommands(): ComposerToolCommandCandidate[] {
  return [
    {
      token: "tools list",
      command: "/tools list",
      displayName: "列出已启用工具集",
      description: "/tools list",
      kind: "builtin",
    },
    {
      token: "tools enable",
      command: "/tools enable ",
      displayName: "启用工具集",
      description: "/tools enable <toolset>",
      kind: "builtin",
    },
    {
      token: "tools disable",
      command: "/tools disable ",
      displayName: "禁用工具集",
      description: "/tools disable <toolset>",
      kind: "builtin",
    },
    {
      token: "toolsets list",
      command: "/toolsets list",
      displayName: "列出所有工具集",
      description: "/toolsets list",
      kind: "builtin",
    },
    {
      token: "toolsets create",
      command: '/toolsets create name tools=tool1,tool2 includes=core desc=""',
      displayName: "创建自定义工具集",
      description: "/toolsets create <name> tools=... includes=... desc=\"...\"",
      kind: "builtin",
    },
  ];
}

/** Label helper for UI. */
export function toolsetLabel(key: string): string {
  const info = (TOOLSETS as Record<string, { description?: string }>)[key];
  return info?.description ?? key;
}
