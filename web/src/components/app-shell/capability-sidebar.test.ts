import { describe, expect, it } from "vitest";
import { CAPABILITY_SECTIONS } from "./capability-sidebar";
import { TOP_TABS } from "./use-active-top-tab";

describe("configuration navigation", () => {
  it("places IM onboarding under §023 in the 02 configuration sidebar", () => {
    const im = CAPABILITY_SECTIONS.find((section) => section.label === "§023 · 消息平台接入");
    expect(im?.items.map((item) => [item.label, item.path])).toEqual([
      ["飞书接入", "/im/feishu"],
      ["微信接入", "/im/weixin"],
    ]);
  });

  it("keeps IM routes inside the 02 configuration top tab", () => {
    const configTab = TOP_TABS.find((tab) => tab.num === "02");
    expect(configTab?.label).toBe("配置");
    expect(configTab?.matches("/im/feishu")).toBe(true);
    expect(configTab?.matches("/im/weixin")).toBe(true);
  });
});
