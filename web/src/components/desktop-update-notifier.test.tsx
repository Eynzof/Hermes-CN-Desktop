// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/desktop-update", () => ({
  checkDesktopUpdate: vi.fn(),
  DESKTOP_UPDATE_AUTO_CHECK_DATE_KEY: "k.auto",
  DESKTOP_UPDATE_DISMISSED_VERSION_KEY: "k.dismissed",
  desktopUpdateDateKey: () => "2026-01-01",
  shouldRunAutoDesktopUpdateCheck: () => true,
  shouldShowDesktopUpdateNotice: (result: { ok: boolean; updateAvailable: boolean; latestVersion?: string }, dismissed: string | null) =>
    Boolean(result.ok && result.updateAvailable && result.latestVersion && result.latestVersion !== dismissed),
}));

vi.mock("@/lib/ui-store", () => ({
  readUiValue: vi.fn(() => null),
  writeUiValue: vi.fn(),
}));

vi.mock("@/lib/external-links", () => ({
  openExternalUrl: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/build-info", () => ({
  versionLabel: (v: string | undefined) => (v ? `v${v}` : "v—"),
}));

vi.mock("@/lib/runtime", () => ({
  runtime: {
    platform: "tauri",
    isPortable: () => false,
  },
}));

vi.mock("@/lib/app-update", () => ({
  installAppUpdate: vi.fn(async () => ({ ok: true })),
  hasAppUpdateBridge: vi.fn(() => false),
}));

import { DesktopUpdateNotifier } from "./desktop-update-notifier";
import * as desktopUpdate from "@/lib/desktop-update";
import { openExternalUrl } from "@/lib/external-links";
import { installAppUpdate, hasAppUpdateBridge } from "@/lib/app-update";

const mockedCheck = vi.mocked(desktopUpdate.checkDesktopUpdate);

function stubUpdateAvailable() {
  mockedCheck.mockResolvedValue({
    ok: true,
    updateAvailable: true,
    currentVersion: "0.7.0",
    latestVersion: "0.8.0",
    downloadUrl: "https://desktop.hermesagent.org.cn/#download",
    manifestUrl: "https://desktop.hermesagent.org.cn/latest.json",
    checkedAtMs: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Keep the jsdom window intact (react-remove-scroll etc. rely on real jsdom
  // APIs like getComputedStyle); only add the bridge surface.
  Object.defineProperty(window, "hermesDesktop", {
    configurable: true,
    value: { checkDesktopUpdate: vi.fn() },
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop;
});

describe("DesktopUpdateNotifier — unified update CTA", () => {
  it("offers 立即更新 when the unified update bridge is available", async () => {
    vi.mocked(hasAppUpdateBridge).mockReturnValue(true);
    stubUpdateAvailable();

    render(<DesktopUpdateNotifier />);
    await waitFor(() => expect(screen.getByText("立即更新")).toBeTruthy());
    expect(screen.queryByText("去官网下载")).toBeNull();
  });

  it("falls back to 去官网下载 when the bridge is unavailable", async () => {
    vi.mocked(hasAppUpdateBridge).mockReturnValue(false);
    stubUpdateAvailable();

    render(<DesktopUpdateNotifier />);
    await waitFor(() => expect(screen.getByText("去官网下载")).toBeTruthy());
    expect(screen.queryByText("立即更新")).toBeNull();
  });

  it("立即更新 triggers the unified install, not the download page", async () => {
    vi.mocked(hasAppUpdateBridge).mockReturnValue(true);
    stubUpdateAvailable();

    render(<DesktopUpdateNotifier />);
    const button = await screen.findByText("立即更新");
    button.click();
    await waitFor(() => expect(installAppUpdate).toHaveBeenCalledTimes(1));
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
