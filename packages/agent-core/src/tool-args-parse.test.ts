import { describe, expect, it } from "vitest";
import { findToolByName, parseToolCallArguments, validateRequiredParameters } from "./tool-args-parse.js";
import type { Tool, ToolCall } from "./types.js";

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "get_weather",
    description: "Get the weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    async execute() {
      return { content: "ok" };
    },
    ...overrides,
  };
}

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: "call_1", name: "get_weather", arguments: {}, ...overrides };
}

describe("parseToolCallArguments", () => {
  it("parses argumentsJson when present (highest priority)", () => {
    const call = makeCall({
      arguments: { city: "ignored" },
      argumentsJson: '{"city":"Shanghai","units":"c"}',
    });
    expect(parseToolCallArguments(makeTool(), call)).toEqual({ city: "Shanghai", units: "c" });
  });

  it("parses a JSON string in arguments", () => {
    const call = makeCall({ arguments: '{"city":"Beijing"}' as unknown as Record<string, unknown> });
    expect(parseToolCallArguments(makeTool(), call)).toEqual({ city: "Beijing" });
  });

  it("round-trips an object in arguments", () => {
    const args = { city: "Shenzhen", nested: { a: [1, 2, 3] } };
    const call = makeCall({ arguments: args });
    const parsed = parseToolCallArguments(makeTool(), call);
    expect(parsed).toEqual(args);
    expect(parsed).not.toBe(args);
  });

  it("handles empty object arguments", () => {
    const call = makeCall({ arguments: {} });
    expect(parseToolCallArguments(makeTool(), call)).toEqual({});
  });

  it("returns the raw string when argumentsJson is invalid JSON", () => {
    const call = makeCall({ argumentsJson: '{"city":' });
    expect(parseToolCallArguments(makeTool(), call)).toBe('{"city":');
  });

  it("returns the raw string when string arguments are invalid JSON", () => {
    const call = makeCall({ arguments: "not json at all" as unknown as Record<string, unknown> });
    expect(parseToolCallArguments(makeTool(), call)).toBe("not json at all");
  });

  it("handles JSON scalars from argumentsJson", () => {
    expect(parseToolCallArguments(makeTool(), makeCall({ argumentsJson: '"plain"' }))).toBe("plain");
    expect(parseToolCallArguments(makeTool(), makeCall({ argumentsJson: "42" }))).toBe(42);
    expect(parseToolCallArguments(makeTool(), makeCall({ argumentsJson: "null" }))).toBeNull();
  });

  it("throws when object arguments cannot be stringified (e.g. circular reference)", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const call = makeCall({ arguments: circular });
    expect(() => parseToolCallArguments(makeTool(), call)).toThrow(TypeError);
  });
});

describe("findToolByName", () => {
  const tools: readonly Tool[] = [makeTool({ name: "a" }), makeTool({ name: "b" })];

  it("returns the matching tool", () => {
    expect(findToolByName("b", tools)?.name).toBe("b");
    expect(findToolByName("a", tools)?.name).toBe("a");
  });

  it("returns undefined when no tool matches", () => {
    expect(findToolByName("missing", tools)).toBeUndefined();
  });

  it("returns undefined for an empty registry", () => {
    expect(findToolByName("a", [])).toBeUndefined();
  });
});

describe("validateRequiredParameters", () => {
  const tool = makeTool();

  it("returns undefined when all required parameters are present", () => {
    expect(validateRequiredParameters(tool, { city: "Shanghai" })).toBeUndefined();
  });

  it("returns a missing-parameter message naming the tool and key", () => {
    expect(validateRequiredParameters(tool, {})).toBe(
      'Missing required parameter "city" for tool "get_weather"',
    );
  });

  it("reports the first missing parameter in declaration order", () => {
    const multi = makeTool({
      name: "multi",
      parameters: { type: "object", required: ["first", "second"] },
    });
    expect(validateRequiredParameters(multi, { second: 1 })).toBe(
      'Missing required parameter "first" for tool "multi"',
    );
  });

  it("treats explicit undefined as missing but other falsy values as present", () => {
    expect(validateRequiredParameters(tool, { city: undefined })).toBe(
      'Missing required parameter "city" for tool "get_weather"',
    );
    expect(validateRequiredParameters(tool, { city: "" })).toBeUndefined();
    expect(validateRequiredParameters(tool, { city: 0 })).toBeUndefined();
    expect(validateRequiredParameters(tool, { city: false })).toBeUndefined();
  });

  it("returns undefined when no required list is declared", () => {
    const noRequired = makeTool({ parameters: { type: "object" } });
    expect(validateRequiredParameters(noRequired, {})).toBeUndefined();
  });

  it("returns undefined when required is not an array", () => {
    const weird = makeTool({
      parameters: { type: "object", required: "city" as unknown as string[] },
    });
    expect(validateRequiredParameters(weird, {})).toBeUndefined();
  });
});
