import { describe, expect, it } from "vitest";
import { CONFIG_ITEMS } from "./capability-sidebar";
import { TOP_TABS } from "./use-active-top-tab";

function tabFor(path: string) {
  return TOP_TABS.find((tab) => tab.matches(path))?.id;
}

describe("TOP_TABS", () => {
  it("keeps config migration under the 02 config tab", () => {
    expect(tabFor("/config-migration")).toBe("skills");
    expect(tabFor("/config-migration/details")).toBe("skills");
  });

  it("shows config migration in the 021 config sidebar section", () => {
    expect(CONFIG_ITEMS.some((item) => item.label === "配置迁移" && item.path === "/config-migration")).toBe(true);
  });
});
