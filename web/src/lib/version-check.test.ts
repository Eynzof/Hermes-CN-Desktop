import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertCompatible,
  getVersionCheckState,
  resetVersionCheck,
  verifyBackendVersion,
} from "./version-check";
import { EXPECTED_BACKEND_VERSION } from "./build-info";

function stubFetch(response: unknown, status = 200) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(response), { status, headers: { "Content-Type": "application/json" } }),
  ) as unknown as typeof globalThis.fetch;
}

describe("version-check", () => {
  beforeEach(() => {
    resetVersionCheck();
    globalThis.fetch = vi.fn(async () => new Response("{}")) as unknown as typeof globalThis.fetch;
    vi.stubGlobal("window", {
      location: { href: "http://localhost:9545/", protocol: "http:" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("web mode", () => {
    it("skips the gate and marks state as ok", async () => {
      const state = await verifyBackendVersion();
      expect(state.kind).toBe("ok");
      expect(state).toMatchObject({ backendVersion: "web" });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("assertCompatible does not throw in web mode", () => {
      expect(() => assertCompatible()).not.toThrow();
      expect(getVersionCheckState().kind).toBe("ok");
    });
  });

  describe("tauri mode", () => {
    beforeEach(() => {
      vi.stubGlobal("window", {
        __TAURI_INTERNALS__: {},
        __HERMES_RUNTIME__: { platform: "tauri", apiBaseUrl: "http://127.0.0.1:9120" },
        location: { href: "http://localhost:9545/", protocol: "http:" },
      });
    });

    it("returns ok when backend version matches", async () => {
      stubFetch({ version: EXPECTED_BACKEND_VERSION, name: "hermes-agent" });

      const state = await verifyBackendVersion();

      expect(state.kind).toBe("ok");
      expect(state).toMatchObject({ backendVersion: EXPECTED_BACKEND_VERSION });
      expect(globalThis.fetch).toHaveBeenCalledWith("http://127.0.0.1:9120/api/version");
    });

    it("returns mismatch when backend version differs", async () => {
      stubFetch({ version: "0.18.0", name: "hermes-agent" });

      const state = await verifyBackendVersion();

      expect(state.kind).toBe("mismatch");
      expect(state).toMatchObject({
        backendVersion: "0.18.0",
        expectedVersion: EXPECTED_BACKEND_VERSION,
      });
    });

    it("returns unavailable when /api/version is missing or unreachable", async () => {
      globalThis.fetch = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof globalThis.fetch;

      const state = await verifyBackendVersion();

      expect(state.kind).toBe("unavailable");
      expect(getVersionCheckState()).toMatchObject({ kind: "unavailable" });
    });

    it("assertCompatible throws on mismatch and invokes fatal dialog", async () => {
      const fatalErrorAndExit = vi.fn(() => new Promise<never>(() => {}));
      vi.stubGlobal("window", {
        __TAURI_INTERNALS__: {},
        __HERMES_RUNTIME__: { platform: "tauri", apiBaseUrl: "http://127.0.0.1:9120" },
        hermesDesktop: { fatalErrorAndExit },
        location: { href: "http://localhost:9545/", protocol: "http:" },
      });

      stubFetch({ version: "0.18.0", name: "hermes-agent" });
      await verifyBackendVersion();

      expect(() => assertCompatible()).toThrow(/backend version mismatch/);
      expect(fatalErrorAndExit).toHaveBeenCalledWith({
        title: "版本不匹配",
        message: expect.stringContaining("前端期望后端版本"),
      });
    });

    it("assertCompatible throws when backend version is unavailable", async () => {
      const fatalErrorAndExit = vi.fn(() => new Promise<never>(() => {}));
      vi.stubGlobal("window", {
        __TAURI_INTERNALS__: {},
        __HERMES_RUNTIME__: { platform: "tauri", apiBaseUrl: "http://127.0.0.1:9120" },
        hermesDesktop: { fatalErrorAndExit },
        location: { href: "http://localhost:9545/", protocol: "http:" },
      });

      globalThis.fetch = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof globalThis.fetch;
      await verifyBackendVersion();

      expect(() => assertCompatible()).toThrow(/backend version unavailable/);
      expect(fatalErrorAndExit).toHaveBeenCalledWith({
        title: "版本验证失败",
        message: expect.stringContaining("无法验证后端版本"),
      });
    });

    it("resetVersionCheck resets state to unchecked", async () => {
      stubFetch({ version: EXPECTED_BACKEND_VERSION, name: "hermes-agent" });
      await verifyBackendVersion();
      expect(getVersionCheckState().kind).toBe("ok");

      resetVersionCheck();

      expect(getVersionCheckState()).toEqual({ kind: "unchecked" });
    });
  });
});
