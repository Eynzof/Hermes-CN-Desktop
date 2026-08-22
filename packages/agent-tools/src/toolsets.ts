/**
 * Toolset catalog and resolver.
 *
 * Mirrors Python `toolsets.py`: recursive `includes`, cycle-safe resolution,
 * `all`/`*` wildcard handling, custom toolsets overlay, and the `kanban`
 * workflow gate that is deliberately opt-in.
 */

import type { CustomToolset, ToolCategoryId, ToolsetDef } from "./types.js";

/** Core + composite + platform toolset catalog. */
export const TOOLSETS: Record<string, ToolsetDef> = {
  // Core toolsets
  core: {
    description: "Core reasoning & control tools",
    tools: ["todo", "clarify", "complete", "think", "delegate_task"],
    includes: [],
    category: "orchestration",
  },
  file: {
    description: "Filesystem read/write/search tools",
    tools: ["file_read", "file_write", "file_search", "file_grep", "file_list"],
    includes: [],
    category: "terminal-files",
  },
  terminal: {
    description: "Local terminal / process execution",
    tools: ["terminal_run", "terminal_status", "process_start", "process_stop"],
    includes: [],
    category: "terminal-files",
  },
  web: {
    description: "Web search and page extraction",
    tools: ["web_search", "web_extract", "web_fetch"],
    includes: [],
    category: "web",
  },
  memory: {
    description: "Built-in memory read/write",
    tools: ["memory_read", "memory_write", "memory_search"],
    includes: [],
    category: "memory-recall",
  },
  session_search: {
    description: "Search and recall past sessions",
    tools: ["session_search"],
    includes: [],
    category: "memory-recall",
  },
  skills: {
    description: "Skill invocation",
    tools: ["skill_invoke", "skill_search"],
    includes: [],
    category: "orchestration",
  },
  code_execution: {
    description: "Sandboxed code execution",
    tools: ["execute_code", "execute_code_status"],
    includes: ["file"],
    category: "orchestration",
  },
  cronjob: {
    description: "Scheduled task tools",
    tools: ["cronjob_schedule", "cronjob_list", "cronjob_cancel"],
    includes: [],
    category: "automation",
  },
  browser: {
    description: "Browser automation tools",
    tools: [
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_scroll",
      "browser_back",
      "browser_press",
      "browser_console",
      "browser_get_images",
      "browser_vision",
      "browser_cdp",
      "browser_dialog",
      "browser_exec",
    ],
    includes: [],
    category: "browser",
  },
  computer_use: {
    description: "Computer-use / CUA tools",
    tools: ["computer_click", "computer_type", "computer_screenshot"],
    includes: [],
    category: "media",
  },
  homeassistant: {
    description: "Home Assistant controls",
    tools: ["ha_call_service", "ha_get_state", "ha_list_entities", "ha_list_services"],
    includes: [],
    category: "integrations",
    tags: ["ha"],
  },
  x_search: {
    description: "X (Twitter) search",
    tools: ["x_search"],
    includes: [],
    category: "integrations",
  },
  spotify: {
    description: "Spotify playback controls",
    tools: [
      "spotify_playback",
      "spotify_devices",
      "spotify_queue",
      "spotify_search",
      "spotify_playlists",
      "spotify_albums",
      "spotify_library",
    ],
    includes: [],
    category: "integrations",
  },
  google_meet: {
    description: "Google Meet headless bot",
    tools: [
      "meet_join",
      "meet_status",
      "meet_transcript",
      "meet_leave",
      "meet_say",
      "meet_setup",
    ],
    includes: [],
    category: "integrations",
    tags: ["google_meet"],
  },
  image_gen: {
    description: "Image generation",
    tools: ["image_generate"],
    includes: [],
    category: "media",
  },
  video: {
    description: "Video generation / editing",
    tools: ["video_generate", "video_edit"],
    includes: [],
    category: "media",
  },
  tts: {
    description: "Text-to-speech",
    tools: ["tts_speak"],
    includes: [],
    category: "media",
  },
  stt: {
    description: "Speech-to-text",
    tools: ["stt_transcribe"],
    includes: [],
    category: "media",
  },
  // Workflow-gated
  kanban: {
    description: "Kanban multi-agent board tools",
    tools: [
      "kanban_create_board",
      "kanban_create_task",
      "kanban_move_task",
      "kanban_assign_worker",
      "kanban_board_status",
    ],
    includes: [],
    category: "orchestration",
    workflowGate: true,
  },
  batch: {
    description: "Batch processing tools",
    tools: ["batch_run", "batch_status"],
    includes: [],
    category: "automation",
  },
  event_hooks: {
    description: "Event hook registration and triggers",
    tools: ["event_hook_register", "event_hook_trigger", "event_hook_list"],
    includes: [],
    category: "automation",
  },
  deliverable: {
    description: "Deliverable packaging and artifact assembly",
    tools: ["deliverable_create", "deliverable_add_file"],
    includes: [],
    category: "orchestration",
  },
  subagent: {
    description: "Subagent swarm and delegation tools",
    tools: ["agent_swarm", "subagent_list"],
    includes: [],
    category: "orchestration",
  },
  automation_helpers: {
    description: "Automation blueprint and suggestion helpers",
    tools: ["suggestions_get", "blueprint_match", "blueprint_list"],
    includes: [],
    category: "automation",
  },
  mcp: {
    description: "MCP server management tools",
    tools: ["mcp_server_add", "mcp_server_remove", "mcp_server_list", "mcp_server_test"],
    includes: [],
    category: "integrations",
  },
  acp_ide: {
    description: "ACP IDE integration tools",
    tools: ["acp_ide_start", "acp_ide_status", "acp_ide_list_sessions"],
    includes: [],
    category: "integrations",
  },
  document_extract: {
    description: "Document text extraction",
    tools: ["document_extract"],
    includes: [],
    category: "integrations",
  },
  subscription_proxy: {
    description: "Subscription proxy controls",
    tools: ["subscription_proxy_status", "subscription_proxy_start"],
    includes: [],
    category: "integrations",
  },
  tool_gateway: {
    description: "Nous Tool Gateway routing",
    tools: ["tool_gateway_status", "tool_gateway_call"],
    includes: [],
    category: "integrations",
  },
  codex_runtime: {
    description: "Codex app-server runtime controls",
    tools: ["codex_runtime_toggle", "codex_runtime_status"],
    includes: [],
    category: "integrations",
  },
  egress_proxy: {
    description: "Egress proxy and secrets import",
    tools: ["egress_proxy_start", "egress_proxy_import_secrets", "egress_proxy_status"],
    includes: [],
    category: "integrations",
  },
  observability: {
    description: "OpenTelemetry observability",
    tools: ["observability_get_config", "observability_set_config"],
    includes: [],
    category: "integrations",
  },
  messaging: {
    description: "Messaging gateway platform controls",
    tools: [
      "messaging_configure",
      "messaging_status",
      "messaging_start",
      "messaging_stop",
      "messaging_send",
    ],
    includes: [],
    category: "integrations",
    tags: ["messaging"],
  },
  // GUI / desktop toolsets
  desktop_ui: {
    description: "Desktop UI session tools",
    tools: ["desktop_notify", "desktop_pick_file", "desktop_preview"],
    includes: [],
    category: "integrations",
  },
  project: {
    description: "Project/workspace scoped tools",
    tools: ["project_list", "project_switch", "project_index"],
    includes: ["file"],
    category: "integrations",
  },
  // Composite toolsets
  coding: {
    description: "Coding posture bundle",
    tools: [],
    includes: ["core", "file", "terminal", "code_execution", "skills"],
    posture: true,
  },
  hermes_cli: {
    description: "CLI default bundle",
    tools: [],
    includes: ["core", "file", "terminal", "web", "memory", "skills"],
  },
  hermes_discord: {
    description: "Discord platform bundle",
    tools: [],
    includes: ["core", "memory", "skills"],
  },
  hermes_telegram: {
    description: "Telegram platform bundle",
    tools: [],
    includes: ["core", "memory", "skills"],
  },
  // Convenience aliases
  all_core: {
    description: "Alias for core",
    tools: [],
    includes: ["core"],
  },
};

/** Special wildcard keys. */
const WILDCARDS = new Set(["all", "*"]);

/** Resolve a single toolset key into a set of tool names. */
export function resolveToolset(
  name: string,
  opts?: {
    customToolsets?: Record<string, CustomToolset>;
    /** If true, `all`/`*` unions every static toolset except workflow-gated ones. */
    includeAll?: boolean;
    /** GUI session enables desktop_ui/project surfacing. */
    isGuiSession?: boolean;
    /** Kanban worker context enables the kanban toolset. */
    kanbanWorker?: boolean;
    /** Registry view: if provided, dynamic toolsets can be resolved by name. */
    registryToolsets?: Set<string>;
  },
): Set<string> {
  const custom = opts?.customToolsets ?? {};
  const registryToolsets = opts?.registryToolsets;

  if (WILDCARDS.has(name)) {
    if (!opts?.includeAll) return new Set();
    const all = new Set<string>();
    for (const [key, def] of Object.entries(TOOLSETS)) {
      if (def.workflowGate) continue;
      for (const t of resolveToolset(key, { ...opts, includeAll: true })) {
        all.add(t);
      }
    }
    for (const c of Object.values(custom)) {
      for (const t of c.tools) all.add(t);
      for (const i of c.includes) {
        for (const t of resolveToolset(i, { ...opts, includeAll: true })) {
          all.add(t);
        }
      }
    }
    return all;
  }

  // Dynamic registry-based toolset (plugins / MCP).
  if (registryToolsets?.has(name)) {
    // We don't know the members statically; return the key itself so callers
    // can resolve via the registry view. For our resolver we treat it as an
    // empty leaf so it can be passed through to registry.getDefinitions().
    return new Set<string>();
  }

  const seen = new Set<string>();
  const result = new Set<string>();

  function visit(key: string) {
    if (seen.has(key)) return;
    seen.add(key);

    if (key === "kanban" && !(opts?.kanbanWorker || opts?.includeAll === false)) {
      // Kanban is only visited here if explicitly requested (includeAll=false path).
    }

    const def = TOOLSETS[key];
    if (def) {
      for (const t of def.tools) result.add(t);
      for (const inc of def.includes) visit(inc);
      return;
    }

    const ct = custom[key];
    if (ct) {
      for (const t of ct.tools) result.add(t);
      for (const inc of ct.includes) visit(inc);
      return;
    }
  }

  visit(name);
  return result;
}

/** Resolve multiple toolset keys and merge their tool names. */
export function resolveMultipleToolsets(
  names: string[],
  opts?: {
    customToolsets?: Record<string, CustomToolset>;
    disabledToolsets?: string[];
    isGuiSession?: boolean;
    kanbanWorker?: boolean;
    registryToolsets?: Set<string>;
  },
): Set<string> {
  const resolved = new Set<string>();
  const hasAll = names.some((n) => WILDCARDS.has(n));

  for (const name of names) {
    if (WILDCARDS.has(name)) continue;
    for (const t of resolveToolset(name, {
      ...opts,
      includeAll: false,
    })) {
      resolved.add(t);
    }
  }

  if (hasAll) {
    for (const t of resolveToolset("all", {
      ...opts,
      includeAll: true,
    })) {
      resolved.add(t);
    }
  }

  // Subtract disabled toolsets.
  const disabled = opts?.disabledToolsets ?? [];
  for (const d of disabled) {
    for (const t of resolveToolset(d, { ...opts, includeAll: true })) {
      resolved.delete(t);
    }
  }

  return resolved;
}

/** True when the key names a known static, custom, or wildcard toolset. */
export function validateToolset(
  name: string,
  opts?: {
    customToolsets?: Record<string, CustomToolset>;
    registryToolsets?: Set<string>;
  },
): boolean {
  if (WILDCARDS.has(name)) return true;
  if (TOOLSETS[name]) return true;
  if (opts?.customToolsets?.[name]) return true;
  if (opts?.registryToolsets?.has(name)) return true;
  return false;
}

/** List all known toolset keys. */
export function getAllToolsetKeys(opts?: {
  customToolsets?: Record<string, CustomToolset>;
  registryToolsets?: Set<string>;
}): string[] {
  const keys = new Set(Object.keys(TOOLSETS));
  for (const k of Object.keys(opts?.customToolsets ?? {})) keys.add(k);
  for (const k of opts?.registryToolsets ?? []) keys.add(k);
  return Array.from(keys).sort();
}

/** Return the category id for a static toolset, if assigned. */
export function getCategoryForToolset(name: string): ToolCategoryId | undefined {
  return TOOLSETS[name]?.category;
}

/** Return all static toolset keys belonging to a category. */
export function getToolsetsByCategory(categoryId: ToolCategoryId): string[] {
  return Object.entries(TOOLSETS)
    .filter(([, def]) => def.category === categoryId)
    .map(([key]) => key);
}

/** Bundle non-core tools into posture/platform toolsets (parity with Python bundle_non_core_tools). */
export function bundleNonCoreTools(
  toolNames: string[],
  toolToToolset: Map<string, string>,
): Map<string, string[]> {
  const bundles = new Map<string, string[]>();
  const core = new Set(resolveMultipleToolsets(["core"]));
  for (const name of toolNames) {
    const toolset = toolToToolset.get(name) ?? "unknown";
    if (core.has(name)) continue;
    const list = bundles.get(toolset) ?? [];
    list.push(name);
    bundles.set(toolset, list);
  }
  return bundles;
}
