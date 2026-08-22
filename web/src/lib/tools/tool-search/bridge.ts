import type { ToolDefinition } from "@hermes/agent-tools";
import type { ListingForm } from "./catalog.js";

export function bridgeToolSchemas(
  deferredCount: number,
  listing: string,
  listingForm: ListingForm,
): ToolDefinition[] {
  const toolSearchDesc = buildToolSearchDescription(listing, listingForm);
  const toolDescribeDesc = buildToolDescribeDescription();
  const toolCallDesc = buildToolCallDescription();

  return [
    {
      type: "function",
      function: {
        name: "tool_search",
        description: toolSearchDesc,
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "tool_describe",
        description: toolDescribeDesc,
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "tool_call",
        description: toolCallDesc,
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            arguments: {},
          },
          required: ["name", "arguments"],
        },
      },
    },
  ];
}

function buildToolSearchDescription(listing: string, form: ListingForm): string {
  const base = "Search the deferred tool catalog.";
  if (form === "none" || !listing) return base;
  return `${base} Available tools (${form}):\n${listing}`;
}

function buildToolDescribeDescription(): string {
  return "Return the full JSON schema for a deferred tool by name.";
}

function buildToolCallDescription(): string {
  return "Call a deferred tool by name with valid JSON arguments.";
}
