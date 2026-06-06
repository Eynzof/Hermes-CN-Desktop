import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  arrayBufferToBase64,
  installTauriBridge,
  isTauriDevMode,
  normalizeTauriInvokeError,
} from "./tauri-bridge";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((command: string, args?: unknown) => {
    if (command === "get_runtime_config") {
      return Promise.resolve({
        apiBaseUrl: "http://127.0.0.1:9120",
        gatewayUrl: "ws://127.0.0.1:9120/api/ws",
        sessionToken: "token",
        currentProfile: "default",
        transport: "sse",
      });
    }
    return Promise.resolve({ command, args });
  });
  (globalThis as any).window = {};
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe("isTauriDevMode", () => {
  it("uses Vite build mode instead of the window URL protocol", () => {
    expect(isTauriDevMode(true)).toBe(true);
    expect(isTauriDevMode(false)).toBe(false);
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

  it("exposes external terminal opening through Tauri IPC", async () => {
    await installTauriBridge();

    await window.hermesDesktop?.terminalOpenExternal?.({ purpose: "gatewaySetup" });

    expect(mockInvoke).toHaveBeenCalledWith("terminal_open_external", {
      input: { purpose: "gatewaySetup" },
    });
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
});
