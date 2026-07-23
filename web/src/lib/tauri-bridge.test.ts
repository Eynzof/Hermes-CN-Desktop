import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  arrayBufferToBase64,
  installTauriBridge,
  isTauriDevMode,
  normalizeTauriInvokeError,
  shouldWaitForManagedRuntime,
} from "./tauri-bridge";

const mockInvoke = vi.fn();
const mockRuntimeStatusUnlisten = vi.fn();
const mockListen = vi.fn(() => Promise.resolve(mockRuntimeStatusUnlisten));
const mockFileDropUnlisten = vi.fn();
let fileDropHandler: ((event: {
  payload: {
    type: "enter" | "over" | "drop" | "leave";
    paths?: string[];
    position?: { x: number; y: number };
  };
}) => void) | null = null;
const mockOnDragDropEvent = vi.fn((handler: NonNullable<typeof fileDropHandler>) => {
  fileDropHandler = handler;
  return Promise.resolve(mockFileDropUnlisten);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: mockOnDragDropEvent,
  }),
}));

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockClear();
  mockRuntimeStatusUnlisten.mockReset();
  mockFileDropUnlisten.mockReset();
  mockOnDragDropEvent.mockClear();
  fileDropHandler = null;
  mockInvoke.mockImplementation((command: string, args?: unknown) => {
    if (command === "get_runtime_config") {
      return Promise.resolve({
        apiBaseUrl: "http://127.0.0.1:9120",
        gatewayUrl: "ws://127.0.0.1:9120/api/ws",
        sessionToken: "token",
        currentProfile: "default",
      });
    }
    return Promise.resolve({ command, args });
  });
  (globalThis as any).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe("isTauriDevMode", () => {
  it("uses Vite build mode instead of the window URL protocol", () => {
    expect(isTauriDevMode(true)).toBe(true);
    expect(isTauriDevMode(false)).toBe(false);
  });

  it("waits only when a managed runtime is expected to be running", () => {
    expect(
      shouldWaitForManagedRuntime({
        apiBaseUrl: "",
        connectionMode: "managed",
        backendReady: false,
        managedRuntimeDesiredState: "running",
      }),
    ).toBe(true);
    expect(
      shouldWaitForManagedRuntime({
        apiBaseUrl: "",
        connectionMode: "managed",
        backendReady: false,
        managedRuntimeDesiredState: "stopped",
      }),
    ).toBe(false);
    expect(
      shouldWaitForManagedRuntime({
        apiBaseUrl: "",
        connectionMode: "managed",
        backendReady: false,
        managedRuntimeDesiredState: "uninstalled",
      }),
    ).toBe(false);
    expect(
      shouldWaitForManagedRuntime({
        apiBaseUrl: "",
        connectionMode: "remote",
        backendReady: false,
        managedRuntimeDesiredState: "running",
      }),
    ).toBe(false);
    expect(
      shouldWaitForManagedRuntime({
        apiBaseUrl: "http://127.0.0.1:9120",
        connectionMode: "managed",
        backendReady: true,
        managedRuntimeDesiredState: "running",
      }),
    ).toBe(false);
    expect(
      shouldWaitForManagedRuntime({
        apiBaseUrl: "",
        connectionMode: "managed",
        backendReady: undefined,
        managedRuntimeDesiredState: undefined,
      }),
    ).toBe(true);
  });

  it("encodes large upload buffers in chunks", () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 256;
    }

    const decoded = Uint8Array.from(atob(arrayBufferToBase64(bytes.buffer)), (char) => char.charCodeAt(0));

    expect(decoded).toEqual(bytes);
  });

  it("exposes config migration scan/import through Tauri IPC", async () => {
    await installTauriBridge();

    await window.hermesDesktop?.scanConfigMigration?.({ manualPath: "/Users/alice/.hermes" });
    await window.hermesDesktop?.importConfigMigration?.({
      sourcePath: "/Users/alice/.hermes",
      recommendedTargetProfile: "imported",
    });

    expect(mockInvoke).toHaveBeenCalledWith("config_migration_scan", {
      input: { manualPath: "/Users/alice/.hermes" },
    });
    expect(mockInvoke).toHaveBeenCalledWith("config_migration_import", {
      input: {
        sourcePath: "/Users/alice/.hermes",
        recommendedTargetProfile: "imported",
      },
    });
  });

  it("exposes debug bundle export through Tauri IPC", async () => {
    await installTauriBridge();

    await window.hermesDesktop?.exportDebugBundle?.({
      frontendDebug: [{ type: "console", summary: "hello" }],
      rendererDiagnostics: { route: "/debug" },
    });

    expect(mockInvoke).toHaveBeenCalledWith("export_debug_bundle", {
      input: {
        frontendDebug: [{ type: "console", summary: "hello" }],
        rendererDiagnostics: { route: "/debug" },
      },
    });
  });

  it("exposes log snapshot export through Tauri IPC", async () => {
    await installTauriBridge();

    await window.hermesDesktop?.exportLogSnapshot?.({
      fileName: "hermes-logs-agent.log",
      content: "hello\n",
      format: "log",
    });

    expect(mockInvoke).toHaveBeenCalledWith("export_log_snapshot", {
      input: {
        fileName: "hermes-logs-agent.log",
        content: "hello\n",
        format: "log",
      },
    });
  });

  it("exposes external URL opening through Tauri IPC", async () => {
    await installTauriBridge();

    await window.hermesDesktop?.openExternalUrl?.({ url: "https://hermesagent.org.cn" });

    expect(mockInvoke).toHaveBeenCalledWith("open_external_url", {
      input: { url: "https://hermesagent.org.cn" },
    });
  });

  it("exposes desktop update checks through Tauri IPC", async () => {
    await installTauriBridge();

    await window.hermesDesktop?.checkDesktopUpdate?.();

    expect(mockInvoke).toHaveBeenCalledWith("desktop_check_update", undefined);
  });

  it("exposes external terminal opening through Tauri IPC", async () => {
    await installTauriBridge();

    await window.hermesDesktop?.terminalOpenExternal?.({ purpose: "gatewaySetup" });

    expect(mockInvoke).toHaveBeenCalledWith("terminal_open_external", {
      input: { purpose: "gatewaySetup" },
    });
  });

  it("exposes native Tauri file drop events through the desktop bridge", async () => {
    await installTauriBridge();

    const received: unknown[] = [];
    const unsubscribe = window.hermesDesktop?.onFileDrop?.((payload) => {
      received.push(payload);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockOnDragDropEvent).toHaveBeenCalledTimes(1);

    fileDropHandler?.({
      payload: { type: "enter", paths: ["/Users/alice/a.txt"], position: { x: 10, y: 20 } },
    });
    fileDropHandler?.({
      payload: { type: "over", position: { x: 11, y: 21 } },
    });
    fileDropHandler?.({
      payload: { type: "drop", paths: ["/Users/alice/a.txt"], position: { x: 12, y: 22 } },
    });
    fileDropHandler?.({
      payload: { type: "leave" },
    });

    expect(received).toEqual([
      { phase: "enter", paths: ["/Users/alice/a.txt"], position: { x: 10, y: 20 } },
      { phase: "over", paths: [], position: { x: 11, y: 21 } },
      { phase: "drop", paths: ["/Users/alice/a.txt"], position: { x: 12, y: 22 } },
      { phase: "leave", paths: [], position: undefined },
    ]);

    unsubscribe?.();
    expect(mockFileDropUnlisten).toHaveBeenCalledTimes(1);
  });

  it("normalizes structured Tauri IPC errors while preserving code and kind", () => {
    const error = normalizeTauriInvokeError({
      code: "not_ready",
      kind: "state",
      message: "Desktop runtime not ready",
      details: { phase: "starting-dashboard" },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Desktop runtime not ready");
    expect((error as any).code).toBe("not_ready");
    expect((error as any).kind).toBe("state");
    expect((error as any).details).toEqual({ phase: "starting-dashboard" });
  });

  it("normalizes legacy string Tauri IPC errors", () => {
    const error = normalizeTauriInvokeError("Desktop runtime not ready");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Desktop runtime not ready");
  });

  it("exposes profile backup export/import through Tauri IPC", async () => {
    await installTauriBridge();

    await window.hermesDesktop?.exportProfileBackup?.();
    await window.hermesDesktop?.importProfileBackup?.();

    expect(mockInvoke).toHaveBeenCalledWith("backup_export_profile");
    expect(mockInvoke).toHaveBeenCalledWith("backup_import_profile");
  });

  it("mounts the renderer without waiting when the managed runtime is intentionally offline", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_runtime_config") {
        return Promise.resolve({
          apiBaseUrl: "",
          gatewayUrl: "",
          currentProfile: "default",
          connectionMode: "managed",
          backendReady: false,
          guideState: "pending",
          managedRuntimeDesiredState: "stopped",
          managedRuntimeLifecycleState: "stopped",
        });
      }
      return Promise.resolve({});
    });

    await installTauriBridge();

    expect(window.__HERMES_RUNTIME__).toMatchObject({
      backendReady: false,
      guideState: "pending",
      managedRuntimeDesiredState: "stopped",
      managedRuntimeLifecycleState: "stopped",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("runtime_info", undefined);
  });

  it("waits for a desired managed runtime and adopts its live session token", async () => {
    let configReads = 0;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_runtime_config") {
        configReads += 1;
        if (configReads === 1) {
          return Promise.resolve({
            apiBaseUrl: "",
            gatewayUrl: "",
            currentProfile: "reviewer",
            connectionMode: "managed",
            backendReady: false,
            guideState: "completed",
            managedRuntimeDesiredState: "running",
            managedRuntimeLifecycleState: "stopped",
          });
        }
        return Promise.resolve({
          apiBaseUrl: "http://127.0.0.1:9120",
          gatewayUrl: "ws://127.0.0.1:9120/api/ws?token=rotated",
          sessionToken: "rotated",
          currentProfile: "reviewer",
          connectionMode: "managed",
          backendReady: true,
          guideState: "completed",
          managedRuntimeDesiredState: "running",
          managedRuntimeLifecycleState: "running",
        });
      }
      if (command === "runtime_info") {
        return Promise.resolve({ lastError: null });
      }
      return Promise.resolve({});
    });

    await installTauriBridge();

    expect(configReads).toBeGreaterThanOrEqual(2);
    expect(mockListen).toHaveBeenCalledWith("runtime-status", expect.any(Function));
    expect(mockRuntimeStatusUnlisten).toHaveBeenCalledTimes(1);
    expect(window.__HERMES_RUNTIME__).toMatchObject({
      sessionToken: "rotated",
      currentProfile: "reviewer",
      backendReady: true,
      managedRuntimeDesiredState: "running",
      managedRuntimeLifecycleState: "running",
    });
  });

  it("exposes persisted guide and managed runtime lifecycle commands", async () => {
    await installTauriBridge();

    await window.hermesDesktop?.setGuideState?.("deferred");
    await window.hermesDesktop?.installManagedRuntime?.();
    await window.hermesDesktop?.startManagedRuntime?.();
    await window.hermesDesktop?.stopManagedRuntime?.();
    await window.hermesDesktop?.uninstallManagedRuntime?.();
    await window.hermesDesktop?.reinstallManagedRuntime?.();

    expect(mockInvoke).toHaveBeenCalledWith("set_guide_state", { input: { guideState: "deferred" } });
    expect(mockInvoke).toHaveBeenCalledWith("managed_runtime_install", undefined);
    expect(mockInvoke).toHaveBeenCalledWith("managed_runtime_start", undefined);
    expect(mockInvoke).toHaveBeenCalledWith("managed_runtime_stop", undefined);
    expect(mockInvoke).toHaveBeenCalledWith("managed_runtime_uninstall", undefined);
    expect(mockInvoke).toHaveBeenCalledWith("managed_runtime_reinstall", undefined);
  });
});
