import { TOOLSETS, resolveToolset as resolveStaticToolset } from "../toolsets.js";
import type { CustomToolset } from "../types.js";
import { ToolRegistry } from "./tool-registry.js";
import type { DynamicToolsetDef } from "./types.js";

export interface ToolsetInfo {
  name: string;
  description: string;
  directTools: string[];
  includes: string[];
  resolvedTools: string[];
  toolCount: number;
  isComposite: boolean;
}

export class ToolsetRegistry {
  private custom = new Map<string, DynamicToolsetDef>();
  private mcp = new Map<string, DynamicToolsetDef>();
  private plugins = new Map<string, DynamicToolsetDef>();

  constructor(private toolRegistry: ToolRegistry) {}

  getToolset(name: string, opts?: { includeRegistry?: boolean; seen?: Set<string> }): DynamicToolsetDef | undefined {
    const include = opts?.includeRegistry ?? true;
    const seen = opts?.seen ?? new Set<string>();
    if (seen.has(name)) return undefined;
    seen.add(name);
    const staticDef = TOOLSETS[name];
    if (staticDef) return staticDef as DynamicToolsetDef;
    if (this.custom.has(name)) return this.custom.get(name);
    if (include) {
      if (this.mcp.has(name)) return this.mcp.get(name);
      if (this.plugins.has(name)) return this.plugins.get(name);
      const alias = this.toolRegistry.getToolsetAliasTarget(name);
      if (alias) {
        // Resolve the canonical target with registry lookups enabled; the seen
        // set guards against alias cycles (a -> b -> a).
        return this.getToolset(alias, { includeRegistry: true, seen });
      }
      const tools = this.toolRegistry.getToolNamesForToolset(name);
      if (tools.length) {
        return { description: `Dynamic toolset ${name}`, tools, includes: [] } as DynamicToolsetDef;
      }
    }
    return undefined;
  }

  resolveToolset(name: string, visited?: Set<string>): string[] {
    if (name === "all" || name === "*") {
      return Array.from(new Set(this.getToolsetNames().flatMap((n) => this.resolveToolset(n, new Set(["all", "*"])))));
    }
    const v = visited ?? new Set<string>();
    if (v.has(name)) return [];
    v.add(name);
    const def = this.getToolset(name, { includeRegistry: true });
    if (!def) return [];
    const result = new Set<string>(def.tools);
    for (const inc of def.includes) {
      for (const t of this.resolveToolset(inc, v)) result.add(t);
    }
    return Array.from(result).sort();
  }

  resolveMultipleToolsets(names: string[], disabled: string[] = []): string[] {
    const resolved = new Set<string>();
    for (const name of names) {
      for (const t of this.resolveToolset(name)) resolved.add(t);
    }
    for (const d of disabled) {
      for (const t of this.resolveToolset(d)) resolved.delete(t);
    }
    return Array.from(resolved).sort();
  }

  getAllToolsets(): Map<string, DynamicToolsetDef> {
    const all = new Map<string, DynamicToolsetDef>();
    for (const [k, v] of Object.entries(TOOLSETS)) all.set(k, v as DynamicToolsetDef);
    for (const [k, v] of this.custom) all.set(k, v);
    for (const [k, v] of this.mcp) all.set(k, v);
    for (const [k, v] of this.plugins) all.set(k, v);
    return all;
  }

  getToolsetNames(): string[] {
    return Array.from(this.getAllToolsets().keys()).sort();
  }

  validate(name: string): boolean {
    return this.getToolsetNames().includes(name) || name === "all" || name === "*";
  }

  createCustomToolset(name: string, description: string, tools: string[], includes: string[]): void {
    this.custom.set(name, { description, tools, includes } as DynamicToolsetDef);
  }

  upsertCustomToolset(def: CustomToolset): void {
    this.custom.set(def.name, { description: def.description, tools: def.tools, includes: def.includes } as DynamicToolsetDef);
  }

  registerMcpToolset(name: string, description: string, tools: string[]): void {
    this.mcp.set(name, { description, tools, includes: [] } as DynamicToolsetDef);
  }

  registerPluginToolset(name: string, description: string, tools: string[]): void {
    this.plugins.set(name, { description, tools, includes: [] } as DynamicToolsetDef);
  }

  getToolsetInfo(name: string): ToolsetInfo | undefined {
    const def = this.getToolset(name);
    if (!def) return undefined;
    const resolved = this.resolveToolset(name);
    return {
      name,
      description: def.description,
      directTools: def.tools,
      includes: def.includes,
      resolvedTools: resolved,
      toolCount: resolved.length,
      isComposite: def.includes.length > 0,
    };
  }
}

/** Wrapper matching the static resolver when no registry is available. */
export function resolveToolset(name: string, opts?: { customToolsets?: Record<string, CustomToolset>; includeAll?: boolean }): Set<string> {
  return resolveStaticToolset(name, opts);
}
