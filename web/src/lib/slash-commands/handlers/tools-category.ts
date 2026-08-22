/**
 * `/tools category <name>` slash command handler.
 *
 * Lists tools grouped by the high-level category model from `@hermes/agent-tools`.
 * Supports category aliases like `todo`, `clarify`, `execute_code`, `delegate_task`,
 * `cronjob`, `ha`, and `mcp`.
 */

import {
  getCategory,
  getToolsByCategory,
  listCategories,
  resolveCategory,
} from "@hermes/agent-tools";
import type { CommandResult } from "../types";

export interface ParsedToolsCategoryArgs {
  categoryName: string;
  listAll: boolean;
}

/**
 * Parse the argument string for `/tools category <name>`.
 *
 * Accepts both `/tools category todo` and the shorter `/tools todo`.
 * When no argument is provided, returns `listAll: true`.
 */
export function parseToolsCategoryArgs(raw: string): ParsedToolsCategoryArgs {
  const trimmed = raw.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return { categoryName: "", listAll: true };
  }

  if (parts[0].toLowerCase() === "category" && parts.length > 1) {
    return { categoryName: parts.slice(1).join(" "), listAll: false };
  }

  return { categoryName: trimmed, listAll: false };
}

function formatCategoryNotFound(name: string): string {
  const known = listCategories().map(
    (c) => `- **${c.labelEn}** (${c.labelZh}): ${c.aliases?.join(", ") ?? c.id}`,
  );
  return [`Unknown tool category: ${name}`, "", "Known categories:", ...known].join("\n");
}

function formatAllCategories(): string {
  const lines = listCategories().map(
    (c) =>
      `- **${c.icon} ${c.labelEn}** (${c.labelZh}) — ${c.aliases?.join(", ") ?? c.id}`,
  );
  return ["**Tool categories**", "", ...lines].join("\n");
}

function formatCategory(name: string): CommandResult {
  const id = resolveCategory(name);
  if (!id) {
    return { type: "error", message: formatCategoryNotFound(name) };
  }

  const category = getCategory(id)!;
  const tools = getToolsByCategory(name);

  if (tools.length === 0) {
    return {
      type: "exec",
      output: `**${category.icon} ${category.labelEn}** — no tools available.`,
    };
  }

  const lines = [
    `**${category.icon} ${category.labelEn}** (${category.labelZh})`,
    category.description,
    "",
    ...tools.map((t) => `- ${t}`),
  ];
  return { type: "exec", output: lines.join("\n") };
}

/**
 * Handle `/tools category <name>` and `/tools` (no args).
 */
export function handleToolsCategory(args: string): CommandResult {
  const parsed = parseToolsCategoryArgs(args);
  if (parsed.listAll) {
    return { type: "exec", output: formatAllCategories() };
  }
  return formatCategory(parsed.categoryName);
}
