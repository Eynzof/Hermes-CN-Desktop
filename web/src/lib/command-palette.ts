import type { FsEntry, SessionSummary, SkillInfo } from "@hermes/protocol";
import { resolveSkillOrigin } from "@/lib/skill-origin";
import { sessionDisplayTitle } from "@/lib/session-title";
import { translateCategory, translateSkill } from "@/lib/skill-translations";
import type { WorkspaceProject } from "@/lib/workspaces";

export type CommandPaletteGroupId = "commands" | "sessions" | "projects" | "skills" | "files";

export type CommandPaletteIconKey =
  | "analytics"
  | "backup"
  | "config"
  | "console"
  | "cron"
  | "debug"
  | "file"
  | "folder"
  | "health"
  | "history"
  | "mcp"
  | "memory"
  | "models"
  | "new"
  | "profiles"
  | "project"
  | "settings"
  | "skill"
  | "soul";

export type CommandPaletteAction =
  | { type: "navigate"; to: string }
  | { type: "open-path"; path: string; fallbackTo?: string };

export interface CommandPaletteItem {
  id: string;
  group: CommandPaletteGroupId;
  label: string;
  subtitle?: string;
  keywords?: string[];
  icon: CommandPaletteIconKey;
  action: CommandPaletteAction;
  /** Empty-query entries. Static commands and recent dynamic entities use this. */
  defaultVisible?: boolean;
  /** Lower values sort first inside a group for empty-query and equal-score matches. */
  priority?: number;
}

export interface CommandPaletteGroup {
  id: CommandPaletteGroupId;
  label: string;
  items: CommandPaletteItem[];
}

export interface CommandPaletteFileCandidate {
  entry: FsEntry;
  projectPath: string;
  projectName: string;
}

interface BuildCommandPaletteItemsInput {
  sessions?: readonly SessionSummary[] | null;
  projects?: readonly WorkspaceProject[] | null;
  skills?: readonly SkillInfo[] | null;
  files?: readonly CommandPaletteFileCandidate[] | null;
}

interface FilterOptions {
  maxPerGroup?: number;
}

const GROUP_ORDER: CommandPaletteGroupId[] = ["commands", "sessions", "projects", "skills", "files"];

export const COMMAND_PALETTE_GROUP_LABELS: Record<CommandPaletteGroupId, string> = {
  commands: "命令",
  sessions: "会话",
  projects: "项目",
  skills: "Skills",
  files: "文件",
};

export const COMMAND_PALETTE_COMMANDS: readonly CommandPaletteItem[] = [
  {
    id: "command-new-session",
    group: "commands",
    label: "新建对话",
    subtitle: "回到工作台并开始新任务",
    keywords: ["new", "chat", "session", "task", "compose", "新任务", "新会话"],
    icon: "new",
    action: { type: "navigate", to: "/" },
    defaultVisible: true,
    priority: 0,
  },
  {
    id: "command-history",
    group: "commands",
    label: "对话历史",
    subtitle: "/history · 搜索、归档和管理会话",
    keywords: ["history", "sessions", "archive", "chat", "conversation", "历史", "会话"],
    icon: "history",
    action: { type: "navigate", to: "/history" },
    defaultVisible: true,
    priority: 1,
  },
  {
    id: "command-projects",
    group: "commands",
    label: "项目 / 工作空间",
    subtitle: "/projects · 查看已登记项目",
    keywords: ["project", "workspace", "folder", "cwd", "工作区", "目录"],
    icon: "project",
    action: { type: "navigate", to: "/projects" },
    defaultVisible: true,
    priority: 2,
  },
  {
    id: "command-kanban",
    group: "commands",
    label: "看板 Kanban",
    subtitle: "/kanban · 打开官方 Dashboard 看板",
    keywords: ["kanban", "board", "dashboard", "official", "看板", "任务板"],
    icon: "project",
    action: { type: "navigate", to: "/kanban" },
    defaultVisible: true,
    priority: 3,
  },
  {
    id: "command-skills",
    group: "commands",
    label: "Skills 管理",
    subtitle: "/skills · 启用、禁用和查看 Skill",
    keywords: ["skills", "tools", "skill", "能力", "技能"],
    icon: "skill",
    action: { type: "navigate", to: "/skills" },
    defaultVisible: true,
    priority: 4,
  },
  {
    id: "command-models",
    group: "commands",
    label: "模型配置",
    subtitle: "/models · Provider、模型与上下文",
    keywords: ["models", "provider", "llm", "ai", "模型", "供应商"],
    icon: "models",
    action: { type: "navigate", to: "/models" },
    defaultVisible: true,
    priority: 5,
  },
  {
    id: "command-mcp",
    group: "commands",
    label: "MCP 服务",
    subtitle: "/mcp · 管理工具服务",
    keywords: ["mcp", "server", "tool", "工具", "服务"],
    icon: "mcp",
    action: { type: "navigate", to: "/mcp" },
    defaultVisible: true,
    priority: 6,
  },
  {
    id: "command-profiles",
    group: "commands",
    label: "档案 Profiles",
    subtitle: "/profiles · 切换独立配置环境",
    keywords: ["profiles", "profile", "environment", "配置档", "档案"],
    icon: "profiles",
    action: { type: "navigate", to: "/profiles" },
    defaultVisible: true,
    priority: 7,
  },
  {
    id: "command-cron",
    group: "commands",
    label: "定时任务",
    subtitle: "/cron · 查看和管理自动化任务",
    keywords: ["cron", "schedule", "automation", "job", "定时", "自动化"],
    icon: "cron",
    action: { type: "navigate", to: "/cron" },
    defaultVisible: true,
    priority: 8,
  },
  {
    id: "command-health",
    group: "commands",
    label: "健康检查",
    subtitle: "/health · Dashboard、模型、环境和扩展状态",
    keywords: ["health", "status", "dashboard", "diagnostics", "检查", "状态"],
    icon: "health",
    action: { type: "navigate", to: "/health" },
    defaultVisible: true,
    priority: 9,
  },
  {
    id: "command-analytics",
    group: "commands",
    label: "数据分析",
    subtitle: "/analytics · Tokens、模型和会话统计",
    keywords: ["analytics", "usage", "tokens", "cost", "statistics", "统计", "用量"],
    icon: "analytics",
    action: { type: "navigate", to: "/analytics" },
    priority: 10,
  },
  {
    id: "command-logs",
    group: "commands",
    label: "日志",
    subtitle: "/logs · 查看运行日志",
    keywords: ["logs", "log", "debug", "journal", "日志"],
    icon: "file",
    action: { type: "navigate", to: "/logs" },
    priority: 11,
  },
  {
    id: "command-debug",
    group: "commands",
    label: "Debug 面板",
    subtitle: "/debug · 导出调试包和排查问题",
    keywords: ["debug", "diagnostics", "bundle", "troubleshoot", "调试", "排障"],
    icon: "debug",
    action: { type: "navigate", to: "/debug" },
    priority: 12,
  },
  {
    id: "command-settings",
    group: "commands",
    label: "常规设置",
    subtitle: "/common · 通知、主题、配置和连接入口",
    keywords: ["settings", "config", "preferences", "common", "设置", "配置"],
    icon: "settings",
    action: { type: "navigate", to: "/common" },
    priority: 13,
  },
  {
    id: "command-backup",
    group: "commands",
    label: "备份恢复",
    subtitle: "/backup · 导入导出 Profile 配置",
    keywords: ["backup", "restore", "export", "import", "备份", "恢复"],
    icon: "backup",
    action: { type: "navigate", to: "/backup" },
    priority: 14,
  },
  {
    id: "command-memory",
    group: "commands",
    label: "记忆",
    subtitle: "/memory · 管理记忆和用户画像",
    keywords: ["memory", "profile", "remember", "记忆", "用户画像"],
    icon: "memory",
    action: { type: "navigate", to: "/memory" },
    priority: 15,
  },
  {
    id: "command-soul",
    group: "commands",
    label: "灵魂 SOUL.md",
    subtitle: "/soul · 编辑智能体核心人格",
    keywords: ["soul", "prompt", "persona", "system prompt", "灵魂", "人格"],
    icon: "soul",
    action: { type: "navigate", to: "/soul" },
    priority: 16,
  },
  {
    id: "command-console",
    group: "commands",
    label: "Hermes Console",
    subtitle: "/console · 运行 Hermes 命令",
    keywords: ["console", "terminal", "command", "shell", "终端", "命令行"],
    icon: "console",
    action: { type: "navigate", to: "/console" },
    priority: 17,
  },
];

function cleanText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function lastActivitySec(session: SessionSummary): number {
  return session.ended_at ?? session.started_at;
}

function searchHaystack(item: CommandPaletteItem): string[] {
  return [
    item.label,
    item.subtitle ?? "",
    item.id,
    ...(item.keywords ?? []),
  ].map((value) => value.toLowerCase());
}

function isSubsequence(query: string, value: string): boolean {
  if (!query) return true;
  let cursor = 0;
  for (const char of value) {
    if (char === query[cursor]) cursor += 1;
    if (cursor === query.length) return true;
  }
  return false;
}

export function commandPaletteItemScore(item: CommandPaletteItem, query: string): number | null {
  const q = normalizeSearch(query);
  if (!q) return item.defaultVisible ? item.priority ?? 0 : null;

  const haystack = searchHaystack(item);
  let best: number | null = null;
  for (const value of haystack) {
    let score: number | null = null;
    if (value === q) score = 0;
    else if (value.startsWith(q)) score = 10;
    else if (value.includes(q)) score = 20;
    else if (isSubsequence(q, value)) score = 80;
    if (score !== null) best = best === null ? score : Math.min(best, score);
  }
  return best;
}

function makeNavigateItem(
  item: Omit<CommandPaletteItem, "action"> & { to: string },
): CommandPaletteItem {
  const { to, ...rest } = item;
  return { ...rest, action: { type: "navigate", to } };
}

function buildSessionItems(sessions: readonly SessionSummary[]): CommandPaletteItem[] {
  return [...sessions]
    .sort((a, b) => lastActivitySec(b) - lastActivitySec(a))
    .slice(0, 200)
    .map((session, index) => {
      const title = sessionDisplayTitle(session);
      const model = cleanText(session.model);
      const preview = cleanText(session.preview);
      return makeNavigateItem({
        id: `session-${session.id}`,
        group: "sessions",
        label: title,
        subtitle: [model || "会话", preview].filter(Boolean).join(" · "),
        keywords: [session.id, title, preview, model, "session", "chat", "conversation", "会话", "对话"].filter(Boolean),
        icon: "history",
        to: `/tasks/${encodeURIComponent(session.id)}`,
        defaultVisible: index < 5,
        priority: index,
      });
    });
}

function buildProjectItems(projects: readonly WorkspaceProject[]): CommandPaletteItem[] {
  return [...projects]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 100)
    .map((project, index) => makeNavigateItem({
      id: `project-${project.path}`,
      group: "projects",
      label: project.name,
      subtitle: project.path,
      keywords: [project.name, project.path, "project", "workspace", "folder", "项目", "工作区"],
      icon: "project",
      to: `/projects/${encodeURIComponent(project.path)}`,
      defaultVisible: index < 5,
      priority: index,
    }));
}

function buildSkillItems(skills: readonly SkillInfo[]): CommandPaletteItem[] {
  return [...skills]
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
    .map((skill, index) => {
      const translated = translateSkill(skill.name, skill.description);
      const category = translateCategory(skill.category);
      const origin = resolveSkillOrigin(skill);
      return makeNavigateItem({
        id: `skill-${skill.name}`,
        group: "skills",
        label: translated.displayName,
        subtitle: `${skill.enabled ? "已启用" : "未启用"} · ${category} · /${skill.name}`,
        keywords: [
          skill.name,
          `/${skill.name}`,
          skill.description,
          translated.displayName,
          translated.description,
          category,
          origin,
          "skill",
          "skills",
          "工具",
          "技能",
        ].filter(Boolean),
        icon: "skill",
        to: `/skills?skill=${encodeURIComponent(skill.name)}`,
        priority: index,
      });
    });
}

export function buildFileItems(files: readonly CommandPaletteFileCandidate[]): CommandPaletteItem[] {
  return files.map(({ entry, projectPath, projectName }, index) => ({
    id: `file-${entry.path}`,
    group: "files",
    label: entry.name,
    subtitle: `${projectName} · ${entry.path}`,
    keywords: [entry.name, entry.path, projectName, projectPath, entry.is_dir ? "directory folder 目录 文件夹" : "file 文件"],
    icon: entry.is_dir ? "folder" : "file",
    action: {
      type: "open-path",
      path: entry.path,
      fallbackTo: `/projects/${encodeURIComponent(projectPath)}`,
    },
    priority: index,
  }));
}

export function buildCommandPaletteItems({
  sessions,
  projects,
  skills,
  files,
}: BuildCommandPaletteItemsInput): CommandPaletteItem[] {
  return [
    ...COMMAND_PALETTE_COMMANDS,
    ...buildSessionItems(sessions ?? []),
    ...buildProjectItems(projects ?? []),
    ...buildSkillItems(skills ?? []),
    ...buildFileItems(files ?? []),
  ];
}

export function filterCommandPaletteGroups(
  items: readonly CommandPaletteItem[],
  query: string,
  options: FilterOptions = {},
): CommandPaletteGroup[] {
  const maxPerGroup = options.maxPerGroup ?? 8;
  const scored = items.flatMap((item, index) => {
    const score = commandPaletteItemScore(item, query);
    return score === null ? [] : [{ item, index, score }];
  });

  const byGroup = new Map<CommandPaletteGroupId, typeof scored>();
  for (const entry of scored) {
    const group = byGroup.get(entry.item.group) ?? [];
    group.push(entry);
    byGroup.set(entry.item.group, group);
  }

  return GROUP_ORDER.flatMap((id) => {
    const group = byGroup.get(id);
    if (!group?.length) return [];
    const itemsForGroup = group
      .sort((a, b) => a.score - b.score || (a.item.priority ?? a.index) - (b.item.priority ?? b.index))
      .slice(0, maxPerGroup)
      .map((entry) => entry.item);
    return [{ id, label: COMMAND_PALETTE_GROUP_LABELS[id], items: itemsForGroup }];
  });
}

export function shouldLoadCommandPaletteFiles(query: string): boolean {
  return normalizeSearch(query).length >= 2;
}
