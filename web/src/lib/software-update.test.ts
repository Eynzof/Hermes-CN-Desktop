// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { __resetUiStoreForTests, readUiValue } from "./ui-store";
import {
  INITIAL_UPDATE_STATE, UPDATE_REMINDER_KEY, UPDATE_REMIND_MS,
  applyUpdateLabel, postponeUpdate, shouldRemindUpdate, updateStatusLabel,
} from "./software-update";

const available = {
  ...INITIAL_UPDATE_STATE, phase: "available" as const,
  targets: [{ kind: "app" as const, version: "0.9.1", currentVersion: "0.9.0", notes: "修复问题", publishedAt: null, size: 1024 }],
};

describe("software update decisions", () => {
  beforeEach(() => __resetUiStoreForTests());

  it("reminds after 24 hours, keeps the badge, and immediately allows a newer release", () => {
    postponeUpdate(available, 1000);
    const remembered = readUiValue<Record<string, number>>(UPDATE_REMINDER_KEY, {});
    expect(shouldRemindUpdate(available, remembered, 1001)).toBe(false);
    expect(updateStatusLabel(available)).toBe("有可用更新");
    expect(shouldRemindUpdate(available, remembered, 1000 + UPDATE_REMIND_MS)).toBe(true);
    expect(shouldRemindUpdate({ ...available, targets: [{ ...available.targets[0], version: "0.9.2" }] }, remembered, 1001)).toBe(true);
  });

  it("waits for real work and does not infer that unknown activity is idle", () => {
    expect(shouldRemindUpdate({ ...available, activities: [{ id: "a", kind: "cron", sessionId: "", pid: 42, started: null }] }, {})).toBe(false);
    expect(shouldRemindUpdate({ ...available, activityError: "unavailable" }, {})).toBe(false);
    expect(shouldRemindUpdate(available, {})).toBe(true);
  });

  it("can remind when a user-requested download becomes ready", () => {
    postponeUpdate(available, 1000);
    expect(shouldRemindUpdate({ ...available, phase: "ready" }, readUiValue(UPDATE_REMINDER_KEY, {}), 1001)).toBe(true);
  });

  it("keeps component updates separate from the installed desktop version", () => {
    const ui = { ...available, targets: [{ ...available.targets[0], kind: "ui" as const }] };
    expect(applyUpdateLabel(ui)).toBe("刷新界面并应用");
    expect(updateStatusLabel({ ...ui, phase: "completed" })).toBe("v0.9.0");
    expect(updateStatusLabel({ ...ui, phase: "downloading", progress: null })).toBe("更新下载中");
  });
});
