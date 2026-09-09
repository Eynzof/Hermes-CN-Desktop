// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoftwareUpdateState } from "@hermes/protocol";
import { DesktopUpdateNotifier, APP_UPDATE_INITIAL_DELAY_MS, nextAppUpdateDelay } from "./desktop-update-notifier";
import { acceptSoftwareUpdateState, INITIAL_UPDATE_STATE } from "@/lib/software-update";
import { __resetUiStoreForTests } from "@/lib/ui-store";

let live: SoftwareUpdateState;
const candidate: SoftwareUpdateState = {
  ...INITIAL_UPDATE_STATE, phase: "available", checkedAt: 1000,
  targets: [{ kind: "app", version: "0.9.1", currentVersion: "0.9.0", notes: "修复会话恢复问题", publishedAt: null, size: 1000 }],
};
function mount() {
  return render(<MemoryRouter><DesktopUpdateNotifier /><Routes><Route path="/updates" element={<h1>软件更新页面</h1>} /></Routes></MemoryRouter>);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  __resetUiStoreForTests();
  live = { ...INITIAL_UPDATE_STATE };
  acceptSoftwareUpdateState(live);
  window.hermesDesktop = {
    softwareUpdateSnapshot: vi.fn(async () => live),
    softwareUpdateAcknowledge: vi.fn(async () => live),
    softwareUpdateCheck: vi.fn(async () => { live = candidate; return live; }),
    softwareUpdateDownload: vi.fn(async () => live),
    softwareUpdateApply: vi.fn(async () => live),
  } as unknown as typeof window.hermesDesktop;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); delete window.hermesDesktop; });

describe("desktop update notification", () => {
  it("checks after startup, presents user language, and never automatically downloads", async () => {
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(APP_UPDATE_INITIAL_DELAY_MS); });
    expect(window.hermesDesktop?.softwareUpdateCheck).toHaveBeenCalledOnce();
    expect(screen.getByText("Hermes 有更新可用")).toBeTruthy();
    expect(screen.getByText("修复会话恢复问题")).toBeTruthy();
    expect(screen.queryByText(/Cloudflare|SHA-256|灰度授权/)).toBeNull();
    expect(window.hermesDesktop?.softwareUpdateDownload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "查看更新" }));
    expect(screen.getByRole("heading", { name: "软件更新页面" })).toBeTruthy();
  });

  it("closing the dialog postpones the same release rather than hiding its update state", async () => {
    live = candidate;
    mount();
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "稍后提醒" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(live.targets).toHaveLength(1);
  });

  it("waits for running tasks and reminds after they finish without applying", async () => {
    live = { ...candidate, phase: "waiting", activities: [{ id: "job", kind: "cron", sessionId: "", pid: 123, started: null }] };
    mount();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("dialog")).toBeNull();
    live = { ...candidate, phase: "ready" };
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText("更新已准备好")).toBeTruthy();
    expect(window.hermesDesktop?.softwareUpdateApply).not.toHaveBeenCalled();
  });

  it("does not interrupt an existing dialog", async () => {
    live = candidate;
    const existing = document.createElement("div");
    existing.setAttribute("role", "dialog"); existing.setAttribute("aria-modal", "true"); document.body.appendChild(existing);
    mount();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText("Hermes 有更新可用")).toBeNull();
    existing.remove();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText("Hermes 有更新可用")).toBeTruthy();
  });

  it("keeps the existing polling jitter bounded", () => {
    expect(nextAppUpdateDelay(() => 0)).toBe(11.5 * 60 * 60 * 1000);
    expect(nextAppUpdateDelay(() => 1)).toBe(12.5 * 60 * 60 * 1000);
  });
});
