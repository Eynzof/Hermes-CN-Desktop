import type { ToolDefinition } from "@hermes/agent-tools";

export const CORE_TOOL_NAMES = new Set([
  "terminal",
  "terminal_run",
  "terminal_status",
  "read_file",
  "write_file",
  "patch",
  "search_files",
  "todo",
  "memory",
  "memory_read",
  "memory_write",
  "browser_navigate",
  "browser_click",
  "browser_screenshot",
  "web_search",
  "web_extract",
  "execute_code",
  "delegate_task",
  "clarify",
  "complete",
  "think",
  "desktop_notify",
  "desktop_pick_file",
  "desktop_preview",
]);

export const BRIDGE_TOOL_NAMES = new Set(["tool_search", "tool_describe", "tool_call"]);

export function isDeferrableToolName(name: string): boolean {
  if (BRIDGE_TOOL_NAMES.has(name)) return false;
  if (CORE_TOOL_NAMES.has(name)) return false;
  if (name.startsWith("mcp-")) return true;
  return true;
}

export function classifyTools(toolDefs: ToolDefinition[]): { visible: ToolDefinition[]; deferrable: ToolDefinition[] } {
  const visible: ToolDefinition[] = [];
  const deferrable: ToolDefinition[] = [];
  for (const def of toolDefs) {
    const name = def.function?.name ?? "";
    if (isDeferrableToolName(name)) deferrable.push(def);
    else visible.push(def);
  }
  return { visible, deferrable };
}
