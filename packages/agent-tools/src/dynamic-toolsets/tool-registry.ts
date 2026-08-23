import type { ToolDefinition } from "../types.js";
import type { DynamicToolEntry } from "./types.js";

export interface RegistrationSnapshot {
  name: string;
  entry: DynamicToolEntry;
}

export class ToolRegistry {
  private tools = new Map<string, DynamicToolEntry>();
  private toolsetAliases = new Map<string, string>();

  register(entry: DynamicToolEntry, opts?: { override?: boolean; scope?: string }): void {
    if (this.tools.has(entry.name) && !opts?.override) {
      throw new Error(`Tool ${entry.name} already registered and override=false`);
    }
    this.tools.set(entry.name, { ...entry, scope: opts?.scope ?? entry.scope });
  }

  deregister(name: string): void {
    this.tools.delete(name);
  }

  getEntry(name: string): DynamicToolEntry | undefined {
    return this.tools.get(name) as DynamicToolEntry | undefined;
  }

  getAllEntries(): DynamicToolEntry[] {
    return Array.from(this.tools.values());
  }

  getToolNamesForToolset(toolset: string): string[] {
    const resolved = this.resolveToolsetAlias(toolset);
    return this.getAllEntries()
      .filter((e) => e.toolset === resolved || this.resolveToolsetAlias(e.toolset) === resolved)
      .map((e) => e.name);
  }

  getRegisteredToolsetNames(): string[] {
    return Array.from(new Set(this.getAllEntries().map((e) => e.toolset)));
  }

  registerToolsetAlias(alias: string, canonical: string): void {
    this.toolsetAliases.set(alias, canonical);
  }

  getToolsetAliasTarget(alias: string): string | undefined {
    return this.toolsetAliases.get(alias);
  }

  resolveToolsetAlias(name: string): string {
    return this.toolsetAliases.get(name) ?? name;
  }

  getDefinitions(toolNames: ReadonlySet<string>): ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const name of toolNames) {
      const entry = this.tools.get(name);
      if (!entry) continue;
      defs.push({
        type: "function",
        function: {
          name: entry.name,
          description: entry.description,
          parameters: entry.schema as import("../types.js").ToolParameterSchema,
        },
      });
    }
    return defs;
  }

  snapshotRegistration(name: string): RegistrationSnapshot | undefined {
    const entry = this.tools.get(name);
    if (!entry) return undefined;
    return { name, entry };
  }

  restoreRegistration(snapshot: RegistrationSnapshot): boolean {
    if (snapshot.name !== snapshot.entry.name) return false;
    this.tools.set(snapshot.name, snapshot.entry as DynamicToolEntry);
    return true;
  }
}
