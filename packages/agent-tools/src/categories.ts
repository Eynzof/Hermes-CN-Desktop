/**
 * Tool category catalog.
 *
 * Mirrors the user-facing category table from the Python docs and `toolsets.py`:
 * Web, Terminal & Files, Browser, Media, Agent orchestration, Memory & recall,
 * Automation, Integrations.
 *
 * Each category owns one or more toolsets and exposes common aliases so
 * `/tools category todo` resolves to "Agent orchestration" just like
 * `/tools category orchestration`.
 */

import { registry } from "./registry.js";
import { getCategoryForToolset, TOOLSETS } from "./toolsets.js";
import type { ToolCategory, ToolCategoryId, ToolEntry } from "./types.js";

// Ensure the built-in catalog is registered so registry-based helpers work.
import "./catalog.js";

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    id: "web",
    labelZh: "网页搜索",
    labelEn: "Web",
    icon: "🌐",
    description: "Search the web and extract content from URLs.",
    toolsets: ["web"],
    aliases: ["web", "search"],
  },
  {
    id: "terminal-files",
    labelZh: "终端与文件",
    labelEn: "Terminal & Files",
    icon: "💻",
    description: "Local shell, process management, and filesystem operations.",
    toolsets: ["terminal", "file"],
    aliases: ["terminal", "files", "shell"],
  },
  {
    id: "browser",
    labelZh: "浏览器自动化",
    labelEn: "Browser",
    icon: "🧭",
    description: "Navigate, click, screenshot, and evaluate scripts in a browser.",
    toolsets: ["browser"],
    aliases: ["browser"],
  },
  {
    id: "media",
    labelZh: "媒体",
    labelEn: "Media",
    icon: "🎬",
    description: "Image generation, video, text-to-speech, and speech-to-text.",
    toolsets: ["image_gen", "video", "tts", "stt", "computer_use"],
    aliases: ["media", "image", "video", "tts", "stt"],
  },
  {
    id: "orchestration",
    labelZh: "智能体编排",
    labelEn: "Agent Orchestration",
    icon: "🤖",
    description: "Todo lists, clarification, code execution, delegation, and skills.",
    toolsets: ["core", "code_execution", "skills", "kanban", "deliverable", "subagent"],
    aliases: ["todo", "clarify", "execute_code", "delegate_task", "orchestration"],
  },
  {
    id: "memory-recall",
    labelZh: "记忆与回忆",
    labelEn: "Memory & Recall",
    icon: "🧠",
    description: "Built-in memory read/write/search and cross-session recall.",
    toolsets: ["memory", "session_search"],
    aliases: ["memory", "recall", "session_search"],
  },
  {
    id: "automation",
    labelZh: "自动化",
    labelEn: "Automation",
    icon: "⏰",
    description: "Scheduled tasks, batch processing, event hooks, and cron jobs.",
    toolsets: ["cronjob", "batch", "event_hooks", "automation_helpers"],
    aliases: ["cronjob", "cron", "automation"],
  },
  {
    id: "integrations",
    labelZh: "集成",
    labelEn: "Integrations",
    icon: "🔌",
    description: "Home Assistant, X search, Spotify, MCP servers, and desktop UI.",
    toolsets: ["homeassistant", "x_search", "spotify", "desktop_ui", "project"],
    aliases: ["ha", "mcp", "homeassistant", "integrations", "spotify", "x_search"],
  },
];

/** Build a quick lookup from alias to category id. */
const ALIAS_TO_CATEGORY = new Map<string, ToolCategoryId>();
for (const category of TOOL_CATEGORIES) {
  ALIAS_TO_CATEGORY.set(category.id, category.id);
  for (const alias of category.aliases ?? []) {
    ALIAS_TO_CATEGORY.set(alias.toLowerCase(), category.id);
  }
}

/** Tool-level category overrides for tools that live in a shared toolset. */
const TOOL_CATEGORY_OVERRIDES: Record<string, ToolCategoryId> = {
  todo: "orchestration",
  clarify: "orchestration",
  complete: "orchestration",
  think: "orchestration",
  delegate_task: "orchestration",
  execute_code: "orchestration",
  execute_code_status: "orchestration",
  cronjob_schedule: "automation",
  cronjob_list: "automation",
  cronjob_cancel: "automation",
  batch_run: "automation",
  batch_status: "automation",
  event_hook_register: "automation",
  event_hook_trigger: "automation",
  event_hook_list: "automation",
  deliverable_create: "orchestration",
  deliverable_add_file: "orchestration",
  agent_swarm: "orchestration",
  subagent_list: "orchestration",
  suggestions_get: "automation",
  blueprint_match: "automation",
  blueprint_list: "automation",
};

/**
 * Resolve a category id or alias to a canonical category id.
 */
export function resolveCategory(name: string): ToolCategoryId | undefined {
  return ALIAS_TO_CATEGORY.get(name.trim().toLowerCase());
}

/**
 * Look up a category by canonical id.
 */
export function getCategory(id: ToolCategoryId): ToolCategory | undefined {
  return TOOL_CATEGORIES.find((c) => c.id === id);
}

/**
 * Return all registered categories.
 */
export function listCategories(): ToolCategory[] {
  return TOOL_CATEGORIES.slice();
}

/**
 * Return the canonical category id for a tool name.
 *
 * Prefers explicit tool-level overrides, then falls back to the tool's
 * toolset category. Supports common prefix patterns (`ha_*`, `mcp_*`).
 */
export function getCategoryForTool(
  name: string,
  toolset?: string,
): ToolCategoryId | undefined {
  const override = TOOL_CATEGORY_OVERRIDES[name];
  if (override) return override;

  if (name.startsWith("ha_")) return "integrations";
  if (name.startsWith("mcp_")) return "integrations";
  if (name.startsWith("cronjob_")) return "automation";

  if (toolset) {
    return getCategoryForToolset(toolset);
  }

  const entry = registry.get(name);
  if (entry?.category) return entry.category;
  if (entry?.toolset) {
    return getCategoryForToolset(entry.toolset);
  }

  return undefined;
}

/**
 * Return all registered tool names that belong to a category (by id or alias).
 */
export function getToolsByCategory(name: string): string[] {
  const id = resolveCategory(name);
  if (!id) return [];

  const names: string[] = [];
  for (const toolName of registry.names()) {
    const entry = registry.get(toolName);
    if (!entry) continue;
    const category = getCategoryForTool(toolName, entry.toolset);
    if (category === id) {
      names.push(toolName);
    }
  }
  return names.sort();
}

/**
 * Return registered tool entries that belong to a category.
 */
export function getToolEntriesByCategory(name: string): ToolEntry[] {
  const names = getToolsByCategory(name);
  return names
    .map((n) => registry.get(n))
    .filter((e): e is ToolEntry => e !== undefined);
}
