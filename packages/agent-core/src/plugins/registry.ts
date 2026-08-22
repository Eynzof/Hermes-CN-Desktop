/**
 * In-process plugin registry.
 *
 * Discovers, loads, enables, and unloads plugins. Provider-category plugins
 * delegate to the existing provider, memory, and context registries so that
 * the agent loop and UI can consume them through the same routes as today.
 */

import type {
  PluginContext,
  PluginDiagnostic,
  PluginDiscoveryResult,
  PluginHookRegistration,
  PluginKind,
  PluginManifest,
  PluginRecord,
  PluginSummary,
  PluginToolRegistration,
} from "./types.js";

export interface PluginRegistryOptions {
  /** Optional list of bundled plugin manifests to seed on construction. */
  bundled?: PluginManifest[];
  /** Optional activator per plugin id for general plugins. */
  activator?: (id: string, ctx: PluginContext) => void | Promise<void>;
  /** Optional hook invoked when a plugin is unloaded. */
  onUnload?: (id: string) => void | Promise<void>;
}

function normalizeId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .replace(/^-+|-+$/g, "");
}

function pushDiagnostic(
  diagnostics: PluginDiagnostic[],
  severity: PluginDiagnostic["severity"],
  code: string,
  message: string,
): void {
  diagnostics.push({ severity, code, message });
}

/** Validate a manifest and return diagnostics + overall ok flag. */
export function validateManifest(manifest: PluginManifest): { ok: boolean; diagnostics: PluginDiagnostic[] } {
  const diagnostics: PluginDiagnostic[] = [];
  let ok = true;

  if (!manifest.name || typeof manifest.name !== "string") {
    pushDiagnostic(diagnostics, "error", "missing_name", "Plugin manifest is missing a non-empty 'name' field.");
    ok = false;
  }

  if (!manifest.version || typeof manifest.version !== "string") {
    pushDiagnostic(diagnostics, "error", "missing_version", "Plugin manifest is missing a non-empty 'version' field.");
    ok = false;
  }

  const validKinds: PluginKind[] = ["general", "model-provider", "memory-provider", "context-engine"];
  if (!validKinds.includes(manifest.kind)) {
    pushDiagnostic(diagnostics, "warning", "unknown_kind", `Unknown plugin kind "${manifest.kind ?? ""}"; treating as "general".`);
    manifest.kind = "general";
  }

  return { ok, diagnostics };
}

function toSummary(record: PluginRecord): PluginSummary {
  return {
    id: record.id,
    name: record.manifest.name,
    title: record.manifest.title,
    version: record.manifest.version,
    description: record.manifest.description,
    kind: record.manifest.kind,
    enabled: record.enabled,
    state: record.state,
    diagnostics: record.diagnostics,
  };
}

/** Build a fresh record from a manifest with default source and diagnostics. */
export function materializeRecord(
  manifest: PluginManifest,
  source: PluginRecord["source"] = "local",
  root = "",
  enabled = false,
): PluginRecord {
  const validation = validateManifest(manifest);
  return {
    id: normalizeId(manifest.name),
    manifest,
    root,
    source,
    enabled,
    diagnostics: validation.diagnostics,
    state: validation.ok ? "ok" : "error",
  };
}

export class PluginRegistry {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly hooks = new Map<string, PluginHookRegistration[]>();
  private readonly tools = new Map<string, PluginToolRegistration[]>();
  private readonly commands = new Map<string, { name: string; description: string }>();
  private readonly unloaders = new Map<string, Array<() => void | Promise<void>>>();
  private readonly options: PluginRegistryOptions;

  constructor(options: PluginRegistryOptions = {}) {
    this.options = options;
    for (const manifest of options.bundled ?? []) {
      this.register(manifest, "bundled", "", false);
    }
  }

  /** Register a plugin from its manifest. */
  register(
    manifest: PluginManifest,
    source: PluginRecord["source"] = "local",
    root = "",
    enabled = false,
  ): PluginRecord {
    const record = materializeRecord(manifest, source, root, enabled);
    this.plugins.set(record.id, record);
    return record;
  }

  /**
   * Discover plugins from a list of manifest sources.
   *
   * This is the declarative equivalent of Python's directory scan. Each entry
   * is validated and added to the registry; callers enable them explicitly.
   */
  discover(manifests: PluginManifest[], source: PluginRecord["source"] = "local"): PluginDiscoveryResult {
    const plugins: PluginRecord[] = [];
    const errors: string[] = [];

    for (const manifest of manifests) {
      try {
        const record = this.register(manifest, source);
        plugins.push(record);
        for (const diagnostic of record.diagnostics) {
          if (diagnostic.severity === "error") {
            errors.push(`[${diagnostic.code}] ${diagnostic.message}`);
          }
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        errors.push(`Failed to register "${manifest.name ?? "unknown"}": ${message}`);
      }
    }

    return { plugins, errors };
  }

  /** Get a record by id. */
  get(id: string): PluginRecord | undefined {
    return this.plugins.get(normalizeId(id));
  }

  /** List all records. */
  list(): PluginRecord[] {
    return Array.from(this.plugins.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** List summaries. */
  summaries(): PluginSummary[] {
    return this.list().map(toSummary);
  }

  /** Set the enabled flag for a plugin. */
  setEnabled(id: string, enabled: boolean): PluginRecord | undefined {
    const record = this.plugins.get(normalizeId(id));
    if (!record) return undefined;
    record.enabled = enabled;
    return record;
  }

  /** Enable a plugin. */
  enable(id: string): PluginRecord | undefined {
    return this.setEnabled(id, true);
  }

  /** Disable a plugin. */
  disable(id: string): PluginRecord | undefined {
    return this.setEnabled(id, false);
  }

  /** Remove a plugin and run any unload hooks. */
  async remove(id: string): Promise<boolean> {
    const normalized = normalizeId(id);
    const record = this.plugins.get(normalized);
    if (!record) return false;

    await this.runUnloaders(normalized);
    this.plugins.delete(normalized);
    this.hooks.delete(normalized);
    this.tools.delete(normalized);
    this.commands.delete(normalized);
    this.unloaders.delete(normalized);
    return true;
  }

  /** Remove every plugin. */
  async clear(): Promise<void> {
    for (const id of Array.from(this.plugins.keys())) {
      await this.remove(id);
    }
  }

  /** Reload a plugin by re-materializing its manifest. */
  reload(id: string, manifest: PluginManifest): PluginRecord | undefined {
    const normalized = normalizeId(id);
    const existing = this.plugins.get(normalized);
    if (!existing) return undefined;

    const record = materializeRecord(manifest, existing.source, existing.root, existing.enabled);
    this.plugins.set(normalized, record);
    return record;
  }

  /** Return ids of plugins that depend on a given plugin id. */
  dependentsOf(id: string): string[] {
    const normalized = normalizeId(id);
    return this.list()
      .filter((p) => p.manifest.requiresPlugins?.includes(normalized))
      .map((p) => p.id);
  }

  /** Filter by kind. */
  byKind(kind: PluginKind): PluginRecord[] {
    return this.list().filter((p) => p.manifest.kind === kind);
  }

  /** Return hook registrations for a plugin, if any. */
  getHooks(id: string): PluginHookRegistration[] {
    return this.hooks.get(normalizeId(id))?.slice() ?? [];
  }

  /** Return tool registrations for a plugin, if any. */
  getTools(id: string): PluginToolRegistration[] {
    return this.tools.get(normalizeId(id))?.slice() ?? [];
  }

  /** Return slash command contributions across all plugins. */
  getCommands(): { name: string; description: string }[] {
    return Array.from(this.commands.values());
  }

  private makeContext(record: PluginRecord): PluginContext {
    return {
      registerHook: (registration) => {
        const list = this.hooks.get(record.id) ?? [];
        list.push(registration);
        this.hooks.set(record.id, list);
      },
      registerTool: (registration) => {
        const list = this.tools.get(record.id) ?? [];
        list.push(registration);
        this.tools.set(record.id, list);
      },
      registerCommand: (command) => {
        this.commands.set(command.name, command);
      },
      emit: async () => {
        // Event bus is intentionally a no-op scaffold for v1.
      },
      hasPlugin: (otherId) => this.plugins.has(normalizeId(otherId)),
      onUnload: (callback) => {
        const list = this.unloaders.get(record.id) ?? [];
        list.push(callback);
        this.unloaders.set(record.id, list);
      },
    };
  }

  /** Activate a general plugin if an activator is configured. */
  async activate(id: string): Promise<PluginRecord | undefined> {
    const record = this.plugins.get(normalizeId(id));
    if (!record || record.manifest.kind !== "general") return undefined;
    if (!this.options.activator) return record;

    const ctx = this.makeContext(record);
    await this.options.activator(record.id, ctx);
    return record;
  }

  private async runUnloaders(id: string): Promise<void> {
    const list = this.unloaders.get(id) ?? [];
    for (const cb of list) {
      try {
        await cb();
      } catch {
        // Ignore unload errors so removal always completes.
      }
    }
    if (this.options.onUnload) {
      try {
        await this.options.onUnload(id);
      } catch {
        // Ignore.
      }
    }
  }
}
