import { describe, expect, it } from "vitest";
import { assembleToolDefs, classifyTools, dispatchToolSearch, dispatchToolDescribe, isBridgeTool, toolSearchConfigFromRaw } from "./index.js";
import type { ToolDefinition } from "@hermes/agent-tools";

function makeTool(name: string, desc: string): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: desc,
      parameters: { type: "object", properties: { x: { type: "string" } } },
    },
  };
}

describe("toolSearchConfigFromRaw", () => {
  it("defaults to auto", () => {
    const cfg = toolSearchConfigFromRaw({});
    expect(cfg.enabled).toBe("auto");
    expect(cfg.maxSearchLimit).toBe(20);
  });

  it("clamps values", () => {
    const cfg = toolSearchConfigFromRaw({ threshold_pct: 200, max_search_limit: 100 });
    expect(cfg.thresholdPct).toBe(100);
    expect(cfg.maxSearchLimit).toBe(50);
  });
});

describe("classifyTools", () => {
  it("keeps core tools visible", () => {
    const tools = [makeTool("terminal", "run command"), makeTool("mcp__gh__star", "star repo")];
    const { visible, deferrable } = classifyTools(tools);
    expect(visible.map((t) => t.function.name)).toContain("terminal");
    expect(deferrable.map((t) => t.function.name)).toContain("mcp__gh__star");
  });
});

describe("assembleToolDefs", () => {
  it("returns bridge tools when enabled", () => {
    const tools = [makeTool("terminal", "run command"), makeTool("plugin_foo", "foo")];
    const result = assembleToolDefs(tools, { contextLength: 128000, config: { enabled: true } });
    expect(result.activated).toBe(true);
    expect(result.toolDefs.some((t) => t.function.name === "tool_search")).toBe(true);
  });

  it("is idempotent", () => {
    const tools = [makeTool("terminal", "run command"), makeTool("plugin_foo", "foo")];
    const first = assembleToolDefs(tools, { contextLength: 128000, config: { enabled: true } });
    const second = assembleToolDefs(first.toolDefs, { contextLength: 128000, config: { enabled: true } });
    expect(second.toolDefs.length).toBe(first.toolDefs.length);
  });
});

describe("dispatchToolSearch", () => {
  it("returns matches", () => {
    const entries = [{ name: "github_search", description: "Search GitHub", schema: {}, source: "plugin", sourceName: "github_search" }];
    const resp = dispatchToolSearch("github", entries);
    expect(resp.matches.length).toBe(1);
    expect(resp.totalAvailable).toBe(1);
  });
});

describe("dispatchToolDescribe", () => {
  it("returns schema for matching name", () => {
    const entries = [{ name: "foo", description: "bar", schema: { type: "object" }, source: "plugin", sourceName: "foo" }];
    expect(dispatchToolDescribe("foo", entries)?.name).toBe("foo");
    expect(dispatchToolDescribe("bar", entries)).toBeNull();
  });
});

describe("isBridgeTool", () => {
  it("identifies bridge tools", () => {
    expect(isBridgeTool("tool_search")).toBe(true);
    expect(isBridgeTool("terminal")).toBe(false);
  });
});
