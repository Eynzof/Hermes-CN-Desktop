import type { ChatToolItem } from "./chat-types";

export type ToolActivityStatus = ChatToolItem["status"];

export interface ToolActivitySummary {
  status: ToolActivityStatus;
  label: string;
  meta?: string;
  error?: string;
  elapsedMs?: number;
}

const TERMINAL_TOOL_NAMES = new Set(["bash", "command", "shell", "terminal"]);

function normalizeName(name: string): string {
  const trimmed = name.trim();
  return trimmed || "tool";
}

function displayName(name: string): string {
  return normalizeName(name).replace(/[_-]+/g, " ");
}

function isTerminalTool(name: string): boolean {
  return TERMINAL_TOOL_NAMES.has(normalizeName(name).toLowerCase());
}

function summarizeCounts(tools: readonly ChatToolItem[]): string | undefined {
  const counts = new Map<string, number>();
  tools.forEach((tool) => {
    const name = normalizeName(tool.name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  });

  const parts = Array.from(counts.entries())
    .sort(([leftName, leftCount], [rightName, rightCount]) => {
      if (leftCount !== rightCount) return rightCount - leftCount;
      return leftName.localeCompare(rightName);
    })
    .slice(0, 3)
    .map(([name, count]) => `${name} x${count}`);

  if (parts.length === 0) return undefined;
  const remaining = counts.size - parts.length;
  return remaining > 0 ? `${parts.join(", ")} +${remaining}` : parts.join(", ");
}

function activityStatus(tools: readonly ChatToolItem[]): ToolActivityStatus {
  if (tools.some((tool) => tool.status === "error")) return "error";
  if (tools.some((tool) => tool.status === "running")) return "running";
  return "done";
}

function activityElapsedMs(
  tools: readonly ChatToolItem[],
  status: ToolActivityStatus,
  now: number,
): number | undefined {
  const startedAt = tools
    .map((tool) => tool.startedAt)
    .filter((value) => Number.isFinite(value));
  if (startedAt.length === 0) return undefined;

  const firstStart = Math.min(...startedAt);
  const lastEnd = Math.max(
    ...tools.map((tool) => {
      if (status === "running" && tool.status === "running") return now;
      return tool.completedAt ?? tool.startedAt;
    }),
  );

  return Math.max(0, lastEnd - firstStart);
}

function activityLabel(
  tools: readonly ChatToolItem[],
  status: ToolActivityStatus,
  errorCount: number,
): string {
  const count = tools.length;
  const terminalOnly = tools.every((tool) => isTerminalTool(tool.name));

  // 中文 UI：状态词本地化，工具原始名称（displayName）保留以便识别。
  if (terminalOnly) {
    if (status === "running") return "正在运行终端命令";
    if (status === "error") {
      if (count === 1) return "终端命令失败";
      return `运行了 ${count} 条终端命令，${errorCount} 条失败`;
    }
    return count === 1 ? "运行了终端命令" : `运行了 ${count} 条终端命令`;
  }

  if (count === 1) {
    const name = displayName(tools[0]?.name ?? "tool");
    if (status === "running") return `正在运行 ${name}`;
    if (status === "error") return `${name} 失败`;
    return `使用了 ${name}`;
  }

  if (status === "running") return `正在使用 ${count} 个工具`;
  if (status === "error") return `使用了 ${count} 个工具，${errorCount} 个失败`;
  return `使用了 ${count} 个工具`;
}

export function summarizeToolActivity(
  tools: readonly ChatToolItem[],
  now = Date.now(),
): ToolActivitySummary {
  const status = activityStatus(tools);
  const failedTool = tools.find((tool) => tool.status === "error");
  const errorCount = tools.filter((tool) => tool.status === "error").length;
  const terminalOnly = tools.length > 0 && tools.every((tool) => isTerminalTool(tool.name));
  const singleTool = tools.length === 1 ? tools[0] : undefined;

  return {
    status,
    label: activityLabel(tools, status, errorCount),
    meta: singleTool?.context?.trim() || (terminalOnly ? undefined : summarizeCounts(tools)),
    error: failedTool?.error,
    elapsedMs: activityElapsedMs(tools, status, now),
  };
}
