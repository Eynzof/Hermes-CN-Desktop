// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import type { SwitchProfileResult } from "@hermes/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./app";
import { installTauriBridge } from "./lib/tauri-bridge";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: vi.fn(async () => {}) }),
}));
vi.mock("./lib/version-check", () => ({
  assertCompatible: vi.fn(),
  resetVersionCheck: vi.fn(),
  recordRuntimeKernelVersion: vi.fn(),
  deferBackendVersionCheckForOfflineRuntime: vi.fn(),
  verifyBackendVersion: vi.fn(async () => ({ kind: "ok" })),
}));
vi.mock("./hooks/use-profiles", () => ({ useBootstrapActiveProfile: vi.fn() }));
vi.mock("./lib/ui-store", () => ({
  readUiValue: (_key: string, fallback: unknown) => fallback,
  removeUiValue: vi.fn(),
}));
vi.mock("./lib/telemetry", () => ({
  sendTelemetryPingIfDue: vi.fn(), sendTokenUsageTelemetryIfDue: vi.fn(),
}));
vi.mock("./components/app-shell/app-shell", () => ({ AppShell: ({ children }: { children: ReactNode }) => children }));
vi.mock("./components/profile-switch-overlay", () => ({ ProfileSwitchOverlay: () => null }));
vi.mock("./components/runtime-update-overlay", () => ({ RuntimeUpdateOverlay: () => null }));
vi.mock("./components/desktop-update-notifier", () => ({ DesktopUpdateNotifier: () => null }));
vi.mock("./components/connection-auth-banner", () => ({ ConnectionAuthBanner: () => null }));
vi.mock("./components/command-palette", () => ({ CommandPalette: () => null }));
vi.mock("./routes/panel", () => ({ PanelRoute: () => <div>在线工作台</div> }));
vi.mock("./routes/offline-shell", () => ({ OfflineShell: () => <div>离线控制台</div> }));

let config: {
  apiBaseUrl: string; gatewayUrl: string; sessionToken: string; currentProfile: string;
  backendReady: boolean; connectionMode: "managed"; managedRuntimeDesiredState: "running" | "stopped";
};
let finishSwitch: (result: SwitchProfileResult) => void;

beforeEach(async () => {
  config = {
    apiBaseUrl: "http://127.0.0.1:9120", gatewayUrl: "ws://127.0.0.1:9120/api/ws",
    sessionToken: "old-token", currentProfile: "default", backendReady: true,
    connectionMode: "managed", managedRuntimeDesiredState: "running",
  };
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "get_runtime_config") return { ...config };
    if (command === "refresh_gateway_url") return { gatewayUrl: config.gatewayUrl, sessionToken: config.sessionToken };
    if (command === "switch_profile") return new Promise<SwitchProfileResult>((resolve) => { finishSwitch = resolve; });
    throw new Error(`Unexpected IPC ${command}`);
  });
  await installTauriBridge();
  render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
  await screen.findByText("在线工作台");
});

afterEach(() => {
  cleanup();
  delete window.hermesDesktop;
  delete window.__HERMES_RUNTIME__;
});

async function beginInterruptedSwitch() {
  const switching = window.hermesDesktop!.switchProfile!({ name: "legacy-profile" });
  await act(async () => {
    config.backendReady = false;
    // The old socket reconnects while Rust has temporarily dropped its handle.
    await window.hermesDesktop!.refreshGatewayUrl!();
  });
  await screen.findByText("离线控制台");
  return { switching };
}

it("returns from the transient offline shell after profile switching without navigation or reload", async () => {
  const { switching } = await beginInterruptedSwitch();
  await act(async () => {
    config = { ...config, backendReady: true, currentProfile: "legacy-profile", sessionToken: "new-token" };
    finishSwitch({ ok: true, profileName: "legacy-profile", apiBaseUrl: config.apiBaseUrl, sessionToken: config.sessionToken });
    await switching;
  });
  await screen.findByText("在线工作台");
  expect(screen.queryByText("离线控制台")).toBeNull();
  expect(window.__HERMES_RUNTIME__).toMatchObject({ currentProfile: "legacy-profile", sessionToken: "new-token" });
});

it.each(["running", "stopped"] as const)("keeps a failed %s runtime offline after the switch finishes", async (desiredState) => {
  const { switching } = await beginInterruptedSwitch();
  await act(async () => {
    config.managedRuntimeDesiredState = desiredState;
    finishSwitch({ ok: false, error: "Target and recovery did not start", recoveredPreviousProfile: false });
    await switching;
  });
  expect(screen.queryByText("在线工作台")).toBeNull();
  expect(screen.getByText("离线控制台")).toBeTruthy();
  expect(window.__HERMES_RUNTIME__?.backendReady).toBe(false);
});

it("adopts the recovered previous profile while preserving the failed switch result", async () => {
  const { switching } = await beginInterruptedSwitch();
  let result: SwitchProfileResult | undefined;
  await act(async () => {
    config = { ...config, backendReady: true, sessionToken: "recovered-token" };
    finishSwitch({ ok: false, error: "Target failed", recoveredPreviousProfile: true });
    result = await switching;
  });
  await screen.findByText("在线工作台");
  expect(result).toMatchObject({ ok: false, recoveredPreviousProfile: true });
  expect(window.__HERMES_RUNTIME__).toMatchObject({ currentProfile: "default", sessionToken: "recovered-token" });
});
