import { describe, expect, it } from "vitest";
import {
  computeContextBreakdown,
  formatContextCategoryLines,
  formatContextGrid,
  formatContextOutput,
  parseContextArgs,
} from "./formatter";
import type { SessionMessage } from "@hermes/protocol";

describe("context-usage formatter", () => {
  const baseSnapshot = {
    model: "gpt-4o",
    systemPrompt: "You are a helpful assistant.",
    rules: "Always be concise.",
    skillsText: "- code_review\n- write_tests",
    memoryText: "User prefers Python.",
    tools: [
      { name: "execute_code", description: "Run code", parameters: { type: "object" } },
      { name: "read_file", description: "Read a file", parameters: { type: "object" } },
    ] as const,
    mcpTools: [{ name: "mcp_search", description: "Search", parameters: { type: "object" } }] as const,
    subagentTools: [] as const,
    conversationMessages: [
      { id: 1, session_id: "s1", role: "user", content: "Hello world", timestamp: 0 },
      { id: 2, session_id: "s1", role: "assistant", content: "Hi there", timestamp: 1 },
    ] as SessionMessage[],
  };

  it("computes 8 categories", () => {
    const breakdown = computeContextBreakdown(baseSnapshot);
    expect(breakdown.categories).toHaveLength(8);
    const ids = breakdown.categories.map((c) => c.id);
    expect(ids).toContain("system_prompt");
    expect(ids).toContain("tool_definitions");
    expect(ids).toContain("rules");
    expect(ids).toContain("skills");
    expect(ids).toContain("mcp");
    expect(ids).toContain("subagent_definitions");
    expect(ids).toContain("memory");
    expect(ids).toContain("conversation");
  });

  it("sums estimated total from categories", () => {
    const breakdown = computeContextBreakdown(baseSnapshot);
    const sum = breakdown.categories.reduce((acc, c) => acc + c.tokens, 0);
    expect(breakdown.estimatedTotal).toBe(sum);
    expect(breakdown.contextUsed).toBe(sum);
  });

  it("caps context percent at 100", () => {
    const breakdown = computeContextBreakdown({ ...baseSnapshot, contextMax: 50 });
    expect(breakdown.contextPercent).toBe(100);
    expect(breakdown.contextUsed).toBeGreaterThan(breakdown.contextMax);
  });

  it("renders a 100-cell grid", () => {
    const breakdown = computeContextBreakdown(baseSnapshot);
    const grid = formatContextGrid(breakdown.categories);
    const lines = grid.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toHaveLength(20);
    const filled = grid.replace(/·/g, "").length;
    expect(filled).toBeGreaterThan(0);
  });

  it("gives every non-zero category at least one grid cell", () => {
    const breakdown = computeContextBreakdown(baseSnapshot);
    const grid = formatContextGrid(breakdown.categories);
    const filled = grid.replace(/·|\n/g, "").length;
    const nonZero = breakdown.categories.filter((c) => c.tokens > 0).length;
    expect(filled).toBeGreaterThanOrEqual(nonZero);
  });

  it("formats category lines", () => {
    const breakdown = computeContextBreakdown(baseSnapshot);
    const lines = formatContextCategoryLines(breakdown);
    expect(lines.length).toBeGreaterThan(8);
    expect(lines.some((line) => line.includes("Free space"))).toBe(true);
  });

  it("formats full /context output", () => {
    const breakdown = computeContextBreakdown(baseSnapshot);
    const output = formatContextOutput(breakdown, { all: true });
    expect(output).toContain("Context Usage");
    expect(output).toContain("Toolsets:");
    expect(output).toContain("builtin");
  });

  it("parses /context args", () => {
    expect(parseContextArgs("").all).toBe(false);
    expect(parseContextArgs("all").all).toBe(true);
    expect(parseContextArgs("  ALL  ").all).toBe(true);
    expect(parseContextArgs("other").all).toBe(false);
  });
});
