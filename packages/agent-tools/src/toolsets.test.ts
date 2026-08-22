import { describe, it, expect } from "vitest";
import {
  TOOLSETS,
  resolveToolset,
  resolveMultipleToolsets,
  validateToolset,
  getAllToolsetKeys,
  bundleNonCoreTools,
} from "./toolsets.js";

describe("resolveToolset", () => {
  it("resolves a leaf toolset", () => {
    const tools = resolveToolset("core");
    expect(tools).toContain("todo");
    expect(tools).toContain("clarify");
  });

  it("resolves composite includes recursively", () => {
    const tools = resolveToolset("coding");
    expect(tools).toContain("todo");
    expect(tools).toContain("terminal_run");
    expect(tools).toContain("execute_code");
  });

  it("expands custom toolsets", () => {
    const tools = resolveToolset("data-science", {
      customToolsets: {
        "data-science": {
          name: "data-science",
          tools: ["web_search", "execute_code"],
          includes: ["file"],
          description: "",
        },
      },
    });
    expect(tools).toContain("web_search");
    expect(tools).toContain("file_read");
  });

  it("all wildcard excludes workflow-gated kanban", () => {
    const all = resolveToolset("all", { includeAll: true });
    expect(all.size).toBeGreaterThan(0);
    expect(all).not.toContain("kanban_create_board");
  });

  it("kanban is available when explicitly requested", () => {
    const tools = resolveToolset("kanban");
    expect(tools).toContain("kanban_create_board");
  });

  it("is cycle-safe", () => {
    const tools = resolveToolset("hermes_cli");
    expect(tools.size).toBeGreaterThan(0);
  });
});

describe("resolveMultipleToolsets", () => {
  it("merges multiple toolsets", () => {
    const tools = resolveMultipleToolsets(["core", "file"]);
    expect(tools).toContain("todo");
    expect(tools).toContain("file_read");
  });

  it("handles all wildcard alongside named sets", () => {
    const tools = resolveMultipleToolsets(["core", "all"]);
    expect(tools).toContain("todo");
    expect(tools).toContain("web_search");
    expect(tools).not.toContain("kanban_create_board");
  });

  it("subtracts disabled toolsets", () => {
    const tools = resolveMultipleToolsets(["hermes_cli"], { disabledToolsets: ["terminal"] });
    expect(tools).toContain("todo");
    expect(tools).not.toContain("terminal_run");
  });
});

describe("validateToolset", () => {
  it("accepts static toolsets", () => {
    expect(validateToolset("core")).toBe(true);
  });

  it("accepts wildcards", () => {
    expect(validateToolset("all")).toBe(true);
    expect(validateToolset("*")).toBe(true);
  });

  it("accepts custom toolsets", () => {
    expect(validateToolset("my-set", { customToolsets: { "my-set": { name: "my-set", tools: [], includes: [], description: "" } } })).toBe(true);
  });

  it("rejects unknown toolsets", () => {
    expect(validateToolset("unknown_xyz")).toBe(false);
  });
});

describe("bundleNonCoreTools", () => {
  it("groups non-core tools by toolset", () => {
    const map = new Map<string, string>([
      ["todo", "core"],
      ["web_search", "web"],
      ["web_extract", "web"],
    ]);
    const bundles = bundleNonCoreTools(["todo", "web_search", "web_extract"], map);
    expect(bundles.get("web")).toEqual(["web_search", "web_extract"]);
    expect(bundles.has("core")).toBe(false);
  });
});

describe("getAllToolsetKeys", () => {
  it("lists static keys", () => {
    const keys = getAllToolsetKeys();
    expect(keys).toContain("core");
    expect(keys).toContain("kanban");
  });
});
