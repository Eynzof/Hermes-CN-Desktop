import { describe, expect, it } from "vitest";
import { CAPABILITY_SECTIONS } from "./capability-sidebar";
import { GATEWAY_SECTIONS } from "./gateway-sidebar";
import { EXTERNAL_MEMORY_ITEMS } from "./external-memory-sidebar";
import { TOP_TABS } from "./use-active-top-tab";

describe("configuration navigation", () => {
  it("moves IM onboarding under §031 in the 03 message gateway sidebar", () => {
    const im = GATEWAY_SECTIONS.find((section) => section.label === "§031 · 消息平台接入");
    expect(im?.items.map((item) => [item.label, item.path])).toEqual([
      ["飞书接入", "/im/feishu"],
      ["微信接入", "/im/weixin"],
    ]);
  });

  it("keeps IM routes inside the 03 message gateway top tab", () => {
    const gatewayTab = TOP_TABS.find((tab) => tab.num === "03");
    expect(gatewayTab?.label).toBe("消息接入");
    expect(gatewayTab?.matches("/im/feishu")).toBe(true);
    expect(gatewayTab?.matches("/im/weixin")).toBe(true);
  });

  it("places backup and migration under §023 in the 02 configuration sidebar", () => {
    const backup = CAPABILITY_SECTIONS.find((section) => section.label === "§023 · 备份与恢复");
    expect(backup?.items.map((item) => [item.label, item.path])).toEqual([
      ["备份恢复", "/backup"],
      ["配置迁移", "/config-migration"],
    ]);
  });

  it("removes memory from configuration", () => {
    const config = CAPABILITY_SECTIONS.find((section) => section.label === "§021 · 配置");
    expect(config?.items.some((item) => item.path === "/memory")).toBe(false);
    expect(config?.items.some((item) => item.label === "外置记忆")).toBe(false);
  });

  it("places built-in memory first in the memory sidebar", () => {
    expect(EXTERNAL_MEMORY_ITEMS.map((item) => [item.label, item.path])).toEqual([
      ["内置记忆", "/memory"],
      ["配置", "/memconfig"],
      ["OpenViking", "/openviking"],
      ["Hindsight", "/hindsight"],
    ]);
  });
});
