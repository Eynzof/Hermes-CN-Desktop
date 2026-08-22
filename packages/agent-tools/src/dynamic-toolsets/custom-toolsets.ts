import type { CustomToolset } from "../types.js";
import { ToolsetRegistry } from "./toolset-registry.js";

export type CustomToolsetInput =
  | string[]
  | { tools?: string[]; includes?: string[] };

export function loadCustomToolsets(
  raw: Record<string, CustomToolsetInput>,
  registry: ToolsetRegistry,
): void {
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      registry.createCustomToolset(name, `Custom toolset ${name}`, [], value);
    } else {
      registry.createCustomToolset(name, `Custom toolset ${name}`, value.tools ?? [], value.includes ?? []);
    }
  }
}

export function customToolsetToDefinition(input: CustomToolsetInput): CustomToolset {
  if (Array.isArray(input)) {
    return { name: "", description: "", tools: [], includes: input };
  }
  return { name: "", description: "", tools: input.tools ?? [], includes: input.includes ?? [] };
}
