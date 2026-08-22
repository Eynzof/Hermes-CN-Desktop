import { Tool, ToolCall } from "./types.js";

export interface ParsedToolCall {
  tool: Tool;
  call: ToolCall;
  parsedArgs: unknown;
}

export function parseToolCallArguments(tool: Tool, call: ToolCall): unknown {
  const raw = call.argumentsJson ??
    (typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments));
  try {
    return JSON.parse(raw);
  } catch {
    // If the model streamed an incomplete JSON blob, surface the raw text so the
    // loop can attempt a repair rather than failing the whole turn.
    return raw;
  }
}

export function findToolByName(name: string, tools: readonly Tool[]): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}

export function validateRequiredParameters(
  tool: Tool,
  args: Record<string, unknown>,
): string | undefined {
  const required = tool.parameters.required;
  if (!Array.isArray(required)) return undefined;
  for (const key of required) {
    if (args[key] === undefined) {
      return `Missing required parameter "${key}" for tool "${tool.name}"`;
    }
  }
  return undefined;
}
