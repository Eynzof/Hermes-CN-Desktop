import { ToolsetRegistry } from "./toolset-registry.js";

export function expandWildcard(registry: ToolsetRegistry): string[] {
  return registry.resolveToolset("all");
}

export function isWildcard(name: string): boolean {
  return name === "all" || name === "*";
}
