import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arrayBufferToBase64, installTauriBridge, isTauriDevMode } from "./tauri-bridge";

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
});
