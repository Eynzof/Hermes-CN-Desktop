import { describe, expect, it } from "vitest";
import {
  handleToolsCategory,
  parseToolsCategoryArgs,
} from "./tools-category";

describe("parseToolsCategoryArgs", () => {
  it("lists all categories when no args", () => {
    const parsed = parseToolsCategoryArgs("");
    expect(parsed.listAll).toBe(true);
    expect(parsed.categoryName).toBe("");
  });

  it("parses /tools category todo", () => {
    const parsed = parseToolsCategoryArgs("category todo");
    expect(parsed.listAll).toBe(false);
    expect(parsed.categoryName).toBe("todo");
  });

  it("parses /tools todo (shorthand)", () => {
    const parsed = parseToolsCategoryArgs("todo");
    expect(parsed.listAll).toBe(false);
    expect(parsed.categoryName).toBe("todo");
  });

  it("preserves multi-word category names", () => {
    const parsed = parseToolsCategoryArgs("category memory-recall");
    expect(parsed.categoryName).toBe("memory-recall");
  });
});

describe("handleToolsCategory", () => {
  it("lists all categories", () => {
    const result = handleToolsCategory("");
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Tool categories");
    expect(result.output).toContain("Agent Orchestration");
    expect(result.output).toContain("Automation");
  });

  it("shows orchestration tools for 'todo'", () => {
    const result = handleToolsCategory("category todo");
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Agent Orchestration");
    expect(result.output).toContain("- todo");
    expect(result.output).toContain("- execute_code");
    expect(result.output).toContain("- delegate_task");
  });

  it("shows automation tools for 'cronjob'", () => {
    const result = handleToolsCategory("cronjob");
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Automation");
    expect(result.output).toContain("- cronjob_schedule");
  });

  it("shows integrations tools for 'ha'", () => {
    const result = handleToolsCategory("ha");
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Integrations");
    expect(result.output).toContain("- ha_call_service");
  });

  it("returns an error for unknown categories", () => {
    const result = handleToolsCategory("nope");
    expect(result.type).toBe("error");
    expect(result.message).toContain("Unknown tool category");
  });
});
