// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acceptSoftwareUpdateState, INITIAL_UPDATE_STATE } from "@/lib/software-update";
import type { SoftwareUpdateState } from "@hermes/protocol";
vi.mock("@/hooks/use-runtime-update", () => ({ useRuntimeInfo: () => ({ data: undefined }) }));
vi.mock("@/lib/use-confirm", () => ({ useConfirm: () => ({ confirm: vi.fn(async () => true) }) }));
vi.mock("./managed-runtime-panel", () => ({ ManagedRuntimePanel: () => <div>高级组件入口</div> }));
vi.mock("@/lib/runtime", () => ({ runtime: { isManaged: () => true } }));
import { UpdatesRoute } from "./updates";
import { SoftwareUpdateStatus } from "@/components/app-shell/software-update-status";
let current: SoftwareUpdateState;
const available = { ...INITIAL_UPDATE_STATE, currentVersion: "0.9.0", phase: "available" as const, checkedAt: 1,
  targets: [{ kind: "ui" as const, currentVersion: "0.9.0", version: "0.9.1", notes: "改进对话体验", publishedAt: null, size: 1024 }] };
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  current = available;
  acceptSoftwareUpdateState(current);
  window.hermesDesktop = {
    softwareUpdateSnapshot: vi.fn(async () => current),
    softwareUpdateCheck: vi.fn(async () => current),
    softwareUpdateDownload: vi.fn(async () => current),
    softwareUpdateCancel: vi.fn(async () => current),
    softwareUpdateApply: vi.fn(async () => current),
  } as unknown as typeof window.hermesDesktop;
});
afterEach(() => { cleanup(); delete window.hermesDesktop; });
async function mount() { await act(async () => { render(<MemoryRouter><UpdatesRoute /><SoftwareUpdateStatus /></MemoryRouter>); }); }
async function update(next: SoftwareUpdateState) { current = next; await act(async () => acceptSoftwareUpdateState(next)); }
describe("consumer software updates", () => {
  it("starts with one download action and keeps advanced controls collapsed", async () => {
    await mount();
    expect(screen.getByText("Hermes Desktop v0.9.0")).toBeTruthy();
    expect(screen.queryByText("高级组件入口")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下载更新" }));
    expect(window.hermesDesktop!.softwareUpdateDownload).toHaveBeenCalledOnce();
    expect(window.hermesDesktop!.softwareUpdateApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("高级更新选项"));
    await act(async () => { screen.getByText("高级更新选项").closest("details")!.open = true; fireEvent(screen.getByText("高级更新选项").closest("details")!, new Event("toggle")); });
    expect(screen.getByText("高级组件入口")).toBeTruthy();
  });
  it("shows received bytes and cancellation while the footer shares progress", async () => {
    await mount();
    await update({ ...available, phase: "downloading", progress: 42, downloadedBytes: 4200, totalBytes: 10000 });
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("42");
    const status = screen.getByRole("link", { name: /更新下载中 42%/ });
    expect(status.getAttribute("href")).toBe("/updates");
    fireEvent.click(screen.getByRole("button", { name: "取消下载" }));
    expect(window.hermesDesktop!.softwareUpdateCancel).toHaveBeenCalledOnce();
  });
  it("waits for running work and only offers apply after it finishes", async () => {
    await mount();
    await update({ ...available, phase: "waiting", activities: [{ id: "a", kind: "cron", sessionId: "job-a", pid: 42, started: null }] });
    expect(screen.getByText("等待任务结束")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "刷新界面并应用" })).toBeNull();
    await update({ ...available, phase: "ready" });
    expect(screen.getByRole("button", { name: "刷新界面并应用" })).toBeTruthy();
    expect(window.hermesDesktop!.softwareUpdateApply).not.toHaveBeenCalled();
  });
  it("keeps technical errors in advanced details and desktop version unchanged for components", async () => {
    current = { ...available, phase: "error", error: { code: "verification_failed", message: "更新包验证未通过，请重新下载。", detail: "SHA256 expected 123" } };
    acceptSoftwareUpdateState(current);
    await mount();
    expect(screen.queryByText(/SHA256 expected/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看详细原因" }));
    expect(screen.getByText(/SHA256 expected/)).toBeTruthy();
    expect(screen.getByText("Hermes Desktop v0.9.0")).toBeTruthy();
  });
});
