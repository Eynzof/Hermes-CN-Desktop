/**
 * Plugin manifest, record, and registry types.
 *
 * This is a TypeScript scaffold for the in-process plugin runtime. It mirrors
 * the portable `plugin.json` / `plugin.yaml` shape from the Python backend but
 * keeps the surface small and safe: declarative manifests plus trusted
 * in-repo adapters for provider categories.
 */

/** Supported plugin categories. */
export type PluginKind =
  | "general"
  | "model-provider"
  | "memory-provider"
  | "context-engine";

/** V1 + V2 manifest fields (V2 fields are optional). */
export interface PluginManifest {
  /** Plugin slug. */
  name: string;
  /** Human-readable display name. */
  title?: string;
  /** Semantic version string. */
  version: string;
  /** One-line description. */
  description?: string;
  /** Author or organization. */
  author?: string;
  /** Plugin category. */
  kind: PluginKind;
  /** Optional manifest version (defaults to 1). */
  manifestVersion?: number;
  /** Optional API compatibility version. */
  apiVersion?: string;
  /** Required environment variables. */
  requiresEnv?: string[];
  /** Required plugins by name. */
  requiresPlugins?: string[];
  /** Config schema declaration (JSON Schema-ish, opaque here). */
  configSchema?: Record<string, unknown>;
  /** License SPDX identifier. */
  license?: string;
  /** Project homepage. */
  homepage?: string;
  /** Search / catalog tags. */
  tags?: string[];
  /** Event types this plugin emits. */
  emits?: string[];
  /** Event types this plugin listens to. */
  listens?: string[];
  /** Capability flags. */
  capabilities?: string[];
  /** Whether this is a portable agent plugin. */
  portable?: boolean;
  /** Skill namespace for disambiguation. */
  skillNamespace?: string;
}

/** Diagnostic severity for plugin materialization. */
export type PluginDiagnosticSeverity = "info" | "warning" | "error";

/** A single materialization diagnostic. */
export interface PluginDiagnostic {
  severity: PluginDiagnosticSeverity;
  code: string;
  message: string;
}

/** Runtime state of a discovered plugin. */
export interface PluginRecord {
  /** Stable plugin id (kebab-case name). */
  id: string;
  /** Parsed manifest. */
  manifest: PluginManifest;
  /** Absolute or relative root path. */
  root: string;
  /** Where the plugin came from. */
  source: "bundled" | "local" | "marketplace" | "pack";
  /** Whether the plugin is enabled. */
  enabled: boolean;
  /** Materialization diagnostics. */
  diagnostics: PluginDiagnostic[];
  /** Runtime state. */
  state: "ok" | "error";
}

/** Short summary suitable for UI lists. */
export interface PluginSummary {
  id: string;
  name: string;
  title?: string;
  version: string;
  description?: string;
  kind: PluginKind;
  enabled: boolean;
  state: "ok" | "error";
  diagnostics: PluginDiagnostic[];
}

/** Discovery result produced by the registry. */
export interface PluginDiscoveryResult {
  plugins: PluginRecord[];
  errors: string[];
}

/** Minimal hook registration surface. */
export interface PluginHookRegistration {
  hook: string;
  handler: (payload: unknown) => unknown | Promise<unknown>;
}

/** Minimal tool registration surface. */
export interface PluginToolRegistration {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  handler: (input: unknown) => unknown | Promise<unknown>;
}

/**
 * Restricted context passed to plugin activation code.
 *
 * This is intentionally small for v1; third-party JS execution is deferred to a
 * later phase.
 */
export interface PluginContext {
  /** Register a hook by name. */
  registerHook: (registration: PluginHookRegistration) => void;
  /** Register a tool by name. */
  registerTool: (registration: PluginToolRegistration) => void;
  /** Register a slash command contribution. */
  registerCommand: (command: { name: string; description: string }) => void;
  /** Emit a namespaced event. */
  emit: (event: string, payload: unknown) => Promise<void>;
  /** Check whether another plugin is loaded. */
  hasPlugin: (id: string) => boolean;
  /** Callback invoked when the plugin is unloaded. */
  onUnload: (callback: () => void | Promise<void>) => void;
}

/** Activation function for general plugins. */
export type PluginActivator = (ctx: PluginContext) => void | Promise<void>;
