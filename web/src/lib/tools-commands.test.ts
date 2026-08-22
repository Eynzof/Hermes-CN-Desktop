import { describe, it, expect } from "vitest";
import {
  handleToolsCommand,
  handleToolsetsCommand,
  getToolComposerCommands,
  parseToolsArgs,
  parseToolsetsArgs,
} from "./tools-commands";
import type { ToolConfigLike } from "@hermes/agent-tools";

const emptyConfig: ToolConfigLike = {};

describe("tools-commands", () => {
  it("parses /tools list", () => {
    expect(parseToolsArgs("list")).toEqual({ subcommand: "list", names: [] });
  });

  it("parses /tools enable", () => {
    expect(parseToolsArgs("enable web file")).toEqual({
      subcommand: "enable",
      names: ["web", "file"],
    });
  });

  it("handles /tools list", () => {
    const res = handleToolsCommand(emptyConfig, "cli", "list");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("已启用");
  });

  it("enables a toolset", () => {
    const res = handleToolsCommand(emptyConfig, "cli", "enable web");
    expect(res.ok).toBe(true);
    expect(res.config.platform_toolsets?.cli).toContain("web");
  });

  it("disables a toolset", () => {
    const cfg = handleToolsCommand(emptyConfig, "cli", "enable web").config;
    const res = handleToolsCommand(cfg, "cli", "disable web");
    expect(res.ok).toBe(true);
    expect(res.config.platform_toolsets?.cli).not.toContain("web");
  });

  it("parses /toolsets create", () => {
    const parsed = parseToolsetsArgs('create myset tools=foo,bar includes=core desc="my set"');
    expect(parsed?.subcommand).toBe("create");
    expect(parsed?.name).toBe("myset");
    expect(parsed?.tools).toEqual(["foo", "bar"]);
    expect(parsed?.includes).toEqual(["core"]);
    expect(parsed?.description).toBe("my set");
  });

  it("creates a custom toolset", () => {
    const res = handleToolsetsCommand(
      emptyConfig,
      "cli",
      'create myset tools=foo,bar includes=core desc="my set"',
    );
    expect(res.ok).toBe(true);
    expect(res.config.custom_toolsets?.myset.tools).toEqual(["foo", "bar"]);
  });

  it("lists composer commands", () => {
    const cmds = getToolComposerCommands();
    expect(cmds.some((c) => c.command === "/tools list")).toBe(true);
    expect(cmds.some((c) => c.command.startsWith("/toolsets create"))).toBe(true);
  });
});
