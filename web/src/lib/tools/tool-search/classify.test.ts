import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@hermes/agent-tools";
import {
  BRIDGE_TOOL_NAMES,
  classifyTools,
  CORE_TOOL_NAMES,
  isDeferrableToolName,
} from "./classify";

function def(name: string): ToolDefinition {
  return {
    function: { name, description: `desc for ${name}`, parameters: { type: "object", properties: {} } },
  } as ToolDefinition;
}

describe("CORE_TOOL_NAMES / BRIDGE_TOOL_NAMES", () => {
  it("lists the core always-visible tools", () => {
    for (const name of ["terminal", "read_file", "write_file", "web_search", "execute_code", "complete"]) {
      expect(CORE_TOOL_NAMES.has(name)).toBe(true);
    }
    expect(CORE_TOOL_NAMES.size).toBeGreaterThan(10);
  });

  it("lists the tool-search bridge tools", () => {
    expect([...BRIDGE_TOOL_NAMES]).toEqual(["tool_search", "tool_describe", "tool_call"]);
  });
});

describe("isDeferrableToolName", () => {
  it("keeps core tools visible (not deferrable)", () => {
    for (const name of ["terminal", "terminal_run", "read_file", "web_search", "execute_code"]) {
      expect(isDeferrableToolName(name)).toBe(false);
    }
  });

  it("keeps bridge tools visible", () => {
    for (const name of ["tool_search", "tool_describe", "tool_call"]) {
      expect(isDeferrableToolName(name)).toBe(false);
    }
  });

  it("defers mcp tools", () => {
    expect(isDeferrableToolName("mcp-filesystem")).toBe(true);
    expect(isDeferrableToolName("mcp")).toBe(true);
  });

  it("defers unknown custom tools", () => {
    expect(isDeferrableToolName("my_custom_tool")).toBe(true);
    expect(isDeferrableToolName("")).toBe(true);
  });
});

describe("classifyTools", () => {
  it("splits defs into visible and deferrable buckets", () => {
    const { visible, deferrable } = classifyTools([
      def("terminal"),
      def("tool_search"),
      def("mcp-github"),
      def("custom_analyze"),
      def("write_file"),
    ]);
    expect(visible.map((d) => d.function?.name)).toEqual(["terminal", "tool_search", "write_file"]);
    expect(deferrable.map((d) => d.function?.name)).toEqual(["mcp-github", "custom_analyze"]);
  });

  it("handles defs without a function name as deferrable", () => {
    const { visible, deferrable } = classifyTools([{ description: "nameless" } as unknown as ToolDefinition]);
    expect(visible).toHaveLength(0);
    expect(deferrable).toHaveLength(1);
  });

  it("handles an empty list", () => {
    const { visible, deferrable } = classifyTools([]);
    expect(visible).toEqual([]);
    expect(deferrable).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [def("terminal"), def("custom")];
    const snapshot = [...input];
    classifyTools(input);
    expect(input).toEqual(snapshot);
  });
});
