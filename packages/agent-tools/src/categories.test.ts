import { describe, it, expect } from "vitest";
import {
  TOOL_CATEGORIES,
  listCategories,
  resolveCategory,
  getCategory,
  getCategoryForTool,
  getToolsByCategory,
  getToolEntriesByCategory,
} from "./categories.js";
import { getCategoryForToolset, getToolsetsByCategory } from "./toolsets.js";

describe("TOOL_CATEGORIES", () => {
  it("contains the eight high-level categories", () => {
    const ids = TOOL_CATEGORIES.map((c) => c.id).sort();
    expect(ids).toEqual(
      [
        "automation",
        "browser",
        "integrations",
        "media",
        "memory-recall",
        "orchestration",
        "terminal-files",
        "web",
      ].sort(),
    );
  });

  it("every category has labels and a non-empty toolset list", () => {
    for (const cat of TOOL_CATEGORIES) {
      expect(cat.labelZh).toBeTruthy();
      expect(cat.labelEn).toBeTruthy();
      expect(cat.toolsets.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveCategory", () => {
  it("resolves canonical ids", () => {
    expect(resolveCategory("orchestration")).toBe("orchestration");
    expect(resolveCategory("automation")).toBe("automation");
  });

  it("resolves aliases for todo/clarify/execute_code/delegate_task", () => {
    expect(resolveCategory("todo")).toBe("orchestration");
    expect(resolveCategory("clarify")).toBe("orchestration");
    expect(resolveCategory("execute_code")).toBe("orchestration");
    expect(resolveCategory("delegate_task")).toBe("orchestration");
  });

  it("resolves cronjob/ha/mcp aliases", () => {
    expect(resolveCategory("cronjob")).toBe("automation");
    expect(resolveCategory("ha")).toBe("integrations");
    expect(resolveCategory("mcp")).toBe("integrations");
  });

  it("is case-insensitive", () => {
    expect(resolveCategory("TODO")).toBe("orchestration");
    expect(resolveCategory("Web")).toBe("web");
  });

  it("returns undefined for unknown aliases", () => {
    expect(resolveCategory("nope")).toBeUndefined();
  });
});

describe("getCategory / getCategoryForToolset", () => {
  it("looks up category metadata", () => {
    const cat = getCategory("orchestration");
    expect(cat?.labelEn).toBe("Agent Orchestration");
    expect(cat?.toolsets).toContain("core");
  });

  it("maps toolsets to categories", () => {
    expect(getCategoryForToolset("web")).toBe("web");
    expect(getCategoryForToolset("cronjob")).toBe("automation");
    expect(getCategoryForToolset("homeassistant")).toBe("integrations");
    expect(getCategoryForToolset("core")).toBe("orchestration");
  });
});

describe("getCategoryForTool", () => {
  it("maps core orchestration tools", () => {
    expect(getCategoryForTool("todo")).toBe("orchestration");
    expect(getCategoryForTool("clarify")).toBe("orchestration");
    expect(getCategoryForTool("delegate_task")).toBe("orchestration");
  });

  it("maps execute_code to orchestration", () => {
    expect(getCategoryForTool("execute_code")).toBe("orchestration");
    expect(getCategoryForTool("execute_code_status")).toBe("orchestration");
  });

  it("maps cronjob tools to automation", () => {
    expect(getCategoryForTool("cronjob_schedule")).toBe("automation");
    expect(getCategoryForTool("cronjob_list")).toBe("automation");
    expect(getCategoryForTool("cronjob_cancel")).toBe("automation");
  });

  it("maps ha_* tools to integrations", () => {
    expect(getCategoryForTool("ha_call_service")).toBe("integrations");
    expect(getCategoryForTool("ha_get_state")).toBe("integrations");
    expect(getCategoryForTool("ha_list_entities")).toBe("integrations");
  });

  it("infers mcp_* tools as integrations", () => {
    expect(getCategoryForTool("mcp_brave")).toBe("integrations");
  });

  it("falls back to toolset category for ordinary tools", () => {
    expect(getCategoryForTool("web_search", "web")).toBe("web");
    expect(getCategoryForTool("file_read", "file")).toBe("terminal-files");
  });
});

describe("getToolsetsByCategory", () => {
  it("returns static toolsets for a category", () => {
    expect(getToolsetsByCategory("orchestration")).toContain("core");
    expect(getToolsetsByCategory("orchestration")).toContain("code_execution");
    expect(getToolsetsByCategory("terminal-files")).toEqual(
      expect.arrayContaining(["terminal", "file"]),
    );
  });
});

describe("getToolsByCategory", () => {
  it("returns todo when asked for orchestration", () => {
    const tools = getToolsByCategory("orchestration");
    expect(tools).toContain("todo");
    expect(tools).toContain("execute_code");
    expect(tools).toContain("delegate_task");
  });

  it("accepts aliases", () => {
    expect(getToolsByCategory("todo")).toContain("todo");
    expect(getToolsByCategory("cronjob")).toContain("cronjob_schedule");
    expect(getToolsByCategory("ha")).toContain("ha_call_service");
  });

  it("returns an empty array for unknown categories", () => {
    expect(getToolsByCategory("unknown")).toEqual([]);
  });

  it("sorts tool names", () => {
    const tools = getToolsByCategory("orchestration");
    expect([...tools].sort()).toEqual(tools);
  });
});

describe("getToolEntriesByCategory", () => {
  it("returns entries with handlers", () => {
    const entries = getToolEntriesByCategory("automation");
    const names = entries.map((e) => e.name);
    expect(names).toContain("cronjob_schedule");
  });
});
