import { describe, expect, it } from "vitest";
import { BACKUP_ITEMS, CONFIG_ITEMS } from "./capability-sidebar";
import { TOP_TABS } from "./use-active-top-tab";

function tabFor(path: string) {
  return TOP_TABS.find((tab) => tab.matches(path))?.id;
}

describe("TOP_TABS", () => {
  it("keeps config migration under the 02 config tab", () => {
    expect(tabFor("/config-migration")).toBe("skills");
    expect(tabFor("/config-migration/details")).toBe("skills");
  });

  it("keeps IM routes under the 03 message gateway tab", () => {
    expect(tabFor("/im/feishu")).toBe("gateway");
    expect(tabFor("/im/weixin")).toBe("gateway");
  });

  it("keeps kanban under the 01 workbench tab", () => {
    expect(tabFor("/kanban")).toBe("workbench");
  });

  it("keeps canonical advanced pages under the 06 advanced tab", () => {
    expect(tabFor("/common")).toBe("advanced");
    expect(tabFor("/notifications")).toBe("advanced");
    expect(tabFor("/config")).toBe("advanced");
    expect(tabFor("/connection")).toBe("advanced");
    expect(tabFor("/kernel")).toBe("advanced");
    expect(tabFor("/env")).toBe("advanced");
    expect(tabFor("/about")).toBe("advanced");
  });

  it("shows config migration in the 023 backup and restore sidebar section", () => {
    expect(BACKUP_ITEMS.some((item) => item.label === "配置迁移" && item.path === "/config-migration")).toBe(true);
  });

  it("keeps backup restore under the 02 config tab and backup sidebar section", () => {
    expect(tabFor("/backup")).toBe("skills");
    expect(BACKUP_ITEMS.some((item) => item.label === "备份恢复" && item.path === "/backup")).toBe(true);
  });

  it("keeps voice setup under the 02 config tab and sidebar section", () => {
    expect(tabFor("/voice")).toBe("skills");
    expect(CONFIG_ITEMS.some((item) => item.label === "语音" && item.path === "/voice")).toBe(true);
  });

  it("keeps soul under the 02 config tab and sidebar section", () => {
    expect(tabFor("/soul")).toBe("skills");
    expect(tabFor("/soul/edit")).toBe("skills");
    expect(CONFIG_ITEMS.some((item) => item.label === "人格" && item.path === "/soul")).toBe(true);
  });

  it("keeps built-in and external memory together under 05 hermes memory", () => {
    expect(tabFor("/memory")).toBe("hermesMemory");
    expect(tabFor("/memconfig")).toBe("hermesMemory");
    expect(tabFor("/openviking")).toBe("hermesMemory");
    expect(tabFor("/hindsight")).toBe("hermesMemory");
    expect(CONFIG_ITEMS.some((item) => item.path === "/memory")).toBe(false);
    expect(CONFIG_ITEMS.some((item) => item.label === "外置记忆")).toBe(false);
  });

  // Wander 记忆窗口暂不可用（MemOS/WanderMemory 服务未接入），04 tab 已注释禁用。
  // 恢复时：取消 use-active-top-tab.ts 中 wanderMemory tab 注释，并把下面改为 toBe("wanderMemory")。
  it("hides the MemOS workbench (wander memory disabled) until the service is usable", () => {
    expect(tabFor("/wander-memory")).toBeUndefined();
    expect(tabFor("/wander-memory/memories")).toBeUndefined();
    expect(tabFor("/wander-memory/files")).toBeUndefined();
    expect(tabFor("/wander-memory/dialogue")).toBeUndefined();
    expect(tabFor("/wander-memory/chat")).toBeUndefined();
    expect(tabFor("/wander-memory/context")).toBeUndefined();
    expect(tabFor("/wander-memory/status")).toBeUndefined();
    expect(tabFor("/wander-memory/api")).toBeUndefined();
  });

  it("keeps memory tab ordering without the disabled wander memory entry", () => {
    expect(TOP_TABS.map((tab) => [tab.num, tab.label])).toEqual([
      ["01", "工作台"],
      ["02", "配置"],
      ["03", "消息接入"],
      ["05", "Hermes 记忆"],
      ["06", "高级"],
    ]);
  });
});
