// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/desktop-update", () => ({
  checkDesktopUpdate: vi.fn(),
  DESKTOP_UPDATE_AUTO_CHECK_DATE_KEY: "k.auto",
  DESKTOP_UPDATE_DISMISSED_VERSION_KEY: "k.dismissed",
  desktopUpdateDateKey: () => "2026-01-01",
  shouldRunAutoDesktopUpdateCheck: () => true,
  shouldShowDesktopUpdateNotice: (
    result: { ok: boolean; updateAvailable: boolean; latestVersion?: string },
    dismissed: string | null,
  ) => Boolean(result.ok && result.updateAvailable && result.latestVersion !== dismissed),
}));

vi.mock("@/lib/ui-store", () => ({
  readUiValue: vi.fn(() => null),
  writeUiValue: vi.fn(),
}));

vi.mock("@/lib/external-links", () => ({
  openExternalUrl: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/build-info", () => ({
  versionLabel: (version: string | undefined) => (version ? `v${version}` : "v—"),
}));

vi.mock("@/lib/runtime", () => ({
  runtime: { platform: "tauri", isPortable: () => false },
}));

vi.mock("@/lib/app-update", () => ({
  checkAppUpdate: vi.fn(),
  downloadAppUpdate: vi.fn(),
  getPendingAppUpdate: vi.fn(async () => ({ ready: false, fallbackUsed: false })),
  installAppUpdate: vi.fn(async () => ({ ok: true, installStarted: true })),
  hasAppUpdateBridge: vi.fn(() => true),
}));

import {
  APP_UPDATE_INITIAL_DELAY_MS,
  DesktopUpdateNotifier,
  nextAppUpdateDelay,
} from "./desktop-update-notifier";
import * as desktopUpdate from "@/lib/desktop-update";
import { openExternalUrl } from "@/lib/external-links";
import {
  checkAppUpdate,
  downloadAppUpdate,
  getPendingAppUpdate,
  hasAppUpdateBridge,
  installAppUpdate,
} from "@/lib/app-update";

const authorised = {
  ok: true,
  updateAvailable: true,
  compatible: true,
  currentVersion: "0.8.0",
  latestVersion: "0.8.1",
  releaseId: "desktop-0.8.1-windows-x86_64",
  channel: "canary",
  manifestSource: "cloudflare-control",
};

async function runInitialCheck() {
  await act(async () => {
    vi.advanceTimersByTime(APP_UPDATE_INITIAL_DELAY_MS);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(checkAppUpdate).mockResolvedValue(authorised);
  vi.mocked(getPendingAppUpdate).mockResolvedValue({ ready: false, fallbackUsed: false });
  vi.mocked(downloadAppUpdate).mockResolvedValue({
    ok: true,
    ready: true,
    version: "0.8.1",
    releaseId: authorised.releaseId,
    manifestSource: "cloudflare-control",
    downloadSource: "cloudflare-cache",
    fallbackUsed: false,
  });
  Object.defineProperty(window, "hermesDesktop", {
    configurable: true,
    value: {
      checkDesktopUpdate: vi.fn(),
      appUpdateCheck: vi.fn(),
      appUpdatePending: vi.fn(),
      appUpdateDownload: vi.fn(),
      appUpdateInstall: vi.fn(),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop;
});

describe("DesktopUpdateNotifier — controlled update flow", () => {
  it("checks the authorised Cloudflare control path only after the 60 second delay", async () => {
    render(<DesktopUpdateNotifier />);
    expect(checkAppUpdate).not.toHaveBeenCalled();
    await runInitialCheck();
    expect(checkAppUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("下载并验证")).toBeTruthy();
    expect(desktopUpdate.checkDesktopUpdate).not.toHaveBeenCalled();
  });

  it("downloads and verifies before offering restart, preserving actual source diagnostics", async () => {
    render(<DesktopUpdateNotifier />);
    await runInitialCheck();
    fireEvent.click(screen.getByText("下载并验证"));
    await act(async () => { await Promise.resolve(); });
    expect(downloadAppUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("立即重启安装")).toBeTruthy();
    expect(screen.getByText(/Cloudflare 缓存/)).toBeTruthy();
    fireEvent.click(screen.getByText("立即重启安装"));
    await act(async () => { await Promise.resolve(); });
    expect(installAppUpdate).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("restores a verified pending package without discovering through GitHub", async () => {
    vi.mocked(getPendingAppUpdate).mockResolvedValue({
      ready: true,
      version: "0.8.1",
      releaseId: authorised.releaseId,
      downloadSource: "github-release",
      fallbackUsed: true,
    });
    render(<DesktopUpdateNotifier />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("立即重启安装")).toBeTruthy();
    expect(screen.getByText(/GitHub Release 回退源/)).toBeTruthy();
    expect(checkAppUpdate).not.toHaveBeenCalled();
  });

  it("keeps the legacy website path only when the new bridge is absent", async () => {
    vi.mocked(hasAppUpdateBridge).mockReturnValue(false);
    vi.mocked(desktopUpdate.checkDesktopUpdate).mockResolvedValue({
      ok: true,
      updateAvailable: true,
      currentVersion: "0.7.0",
      latestVersion: "0.8.0",
      downloadUrl: "https://desktop.hermesagent.org.cn/#download",
      manifestUrl: "https://desktop.hermesagent.org.cn/latest.json",
      checkedAtMs: 1,
    });
    render(<DesktopUpdateNotifier />);
    await runInitialCheck();
    fireEvent.click(screen.getByText("手工下载"));
    await act(async () => { await Promise.resolve(); });
    expect(openExternalUrl).toHaveBeenCalledWith("https://desktop.hermesagent.org.cn/#download");
    expect(checkAppUpdate).not.toHaveBeenCalled();
  });

  it("adds a bounded 12-hour jitter", () => {
    expect(nextAppUpdateDelay(() => 0)).toBe(11.5 * 60 * 60 * 1_000);
    expect(nextAppUpdateDelay(() => 1)).toBe(12.5 * 60 * 60 * 1_000);
  });
});
