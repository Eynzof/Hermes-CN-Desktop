import { describe, expect, it } from "vitest";
import type { FsEntry, SessionSummary, SkillInfo } from "@hermes/protocol";
import {
  buildCommandPaletteItems,
  buildFileItems,
  COMMAND_PALETTE_COMMANDS,
  filterCommandPaletteGroups,
  shouldLoadCommandPaletteFiles,
} from "./command-palette";
import type { WorkspaceProject } from "./workspaces";

function session(id: string, title: string, preview = ""): SessionSummary {
  return {
    id,
    model: "gpt-test",
    title,
    preview,
    started_at: 100,
    ended_at: 200,
    message_count: 1,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: null,
  };
}

function project(path: string, name: string): WorkspaceProject {
  return { path, name, createdAt: 1, updatedAt: 2 };
}

function skill(name: string, description: string, enabled = true): SkillInfo {
  return { name, description, category: "software-development", enabled, origin: "builtin" };
}

function groupLabels(query: string, items = buildCommandPaletteItems({})): string[] {
  return filterCommandPaletteGroups(items, query, { maxPerGroup: 20 })
    .flatMap((group) => group.items.map((item) => item.label));
}

describe("command palette item building and filtering", () => {
  it("matches fixed commands by Chinese and English keywords", () => {
    expect(groupLabels("健康")).toContain("健康检查");
    expect(groupLabels("provider")).toContain("模型配置");
  });

  it("includes a Kanban command that navigates to the desktop guide route", () => {
    const command = COMMAND_PALETTE_COMMANDS.find((item) => item.id === "command-kanban");
    expect(command?.label).toBe("看板 Kanban");
    expect(command?.action).toEqual({ type: "navigate", to: "/kanban" });
    expect(groupLabels("kanban")).toContain("看板 Kanban");
    expect(groupLabels("看板")).toContain("看板 Kanban");
  });

  it("includes Plugins lifecycle management", () => {
    const command = COMMAND_PALETTE_COMMANDS.find((item) => item.id === "command-plugins");
    expect(command?.action).toEqual({ type: "navigate", to: "/plugins" });
    expect(groupLabels("插件")).toContain("Plugins 管理");
  });

  it("matches sessions by title, preview and id", () => {
    const items = buildCommandPaletteItems({
      sessions: [session("session-abc123", "修复登录问题", "检查 token 刷新")],
    });

    expect(groupLabels("登录", items)).toContain("修复登录问题");
    expect(groupLabels("abc123", items)).toContain("修复登录问题");
    expect(groupLabels("token", items)).toContain("修复登录问题");
  });

  it("matches projects by display name and absolute path", () => {
    const items = buildCommandPaletteItems({
      projects: [project("/Users/enzo/work/Hermes-CN-Desktop", "Hermes Desktop")],
    });

    expect(groupLabels("Desktop", items)).toContain("Hermes Desktop");
    expect(groupLabels("/Users/enzo/work", items)).toContain("Hermes Desktop");
  });

  it("matches Skills by raw name and translated Chinese label", () => {
    const items = buildCommandPaletteItems({
      skills: [skill("codex", "Use Codex CLI to implement features")],
    });

    expect(groupLabels("/codex", items)).toContain("Codex 代写");
    expect(groupLabels("代写", items)).toContain("Codex 代写");
  });

  it("keeps empty query focused on fixed commands and recent dynamic entities", () => {
    const items = buildCommandPaletteItems({
      sessions: [session("s1", "最近会话")],
      projects: [project("/Users/enzo/project", "最近项目")],
      skills: [skill("codex", "Use Codex CLI")],
    });
    const labels = groupLabels("", items);

    expect(labels).toContain("新建对话");
    expect(labels).toContain("最近会话");
    expect(labels).toContain("最近项目");
    expect(labels).not.toContain("Codex 代写");
  });

  it("builds file open actions from bounded fs/list entries", () => {
    const entry: FsEntry = { name: "README.md", path: "/Users/enzo/project/README.md", is_dir: false };
    const [item] = buildFileItems([{ entry, projectPath: "/Users/enzo/project", projectName: "project" }]);

    expect(item).toMatchObject({
      label: "README.md",
      group: "files",
      action: { type: "open-path", path: "/Users/enzo/project/README.md" },
    });
  });

  it("does not load file search until the query has at least two characters", () => {
    expect(shouldLoadCommandPaletteFiles("")).toBe(false);
    expect(shouldLoadCommandPaletteFiles("a")).toBe(false);
    expect(shouldLoadCommandPaletteFiles("中文")).toBe(true);
    expect(shouldLoadCommandPaletteFiles("ab")).toBe(true);
  });
});
