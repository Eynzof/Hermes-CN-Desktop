import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertCompatible,
  deferBackendVersionCheckForOfflineRuntime,
  expectedBackendVersion,
  getVersionCheckState,
  recordRuntimeKernelVersion,
  resetVersionCheck,
  verifyBackendVersion,
} from "./version-check";
import { EXPECTED_BACKEND_VERSION } from "./build-info";

function stubDesktopRequest(response: unknown, status = 200) {
  const request = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(response),
  }));
  window.hermesDesktop = {
    ...window.hermesDesktop,
    windowType: "tauri",
    request,
  };
  return request;
}

function stubDesktopRequestError(error: Error & { code?: string; kind?: string }) {
  const request = vi.fn(async () => {
    throw error;
  });
  window.hermesDesktop = {
    ...window.hermesDesktop,
    windowType: "tauri",
    request,
  };
  return request;
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
      const request = stubDesktopRequest({ version: EXPECTED_BACKEND_VERSION, name: "hermes-agent" });

      const state = await verifyBackendVersion();

      expect(state.kind).toBe("ok");
      expect(state).toMatchObject({ backendVersion: EXPECTED_BACKEND_VERSION });
      expect(request).toHaveBeenCalledWith({ path: "/api/version", method: "GET" });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("returns mismatch when backend version differs", async () => {
      stubDesktopRequest({ version: "0.18.0", name: "hermes-agent" });

      const state = await verifyBackendVersion(undefined, { connectionMode: "remote" });

      expect(state.kind).toBe("mismatch");
      expect(state).toMatchObject({
        backendVersion: "0.18.0",
        expectedVersion: "0.20.x",
      });
    });

    it("accepts another patch version in the compatible Core series for an external backend", async () => {
      stubDesktopRequest({ version: "0.20.9", name: "hermes-agent" });

      const state = await verifyBackendVersion(undefined, { connectionMode: "remote" });

      expect(state).toEqual({ kind: "ok", backendVersion: "0.20.9" });
    });

    it("returns unavailable when /api/version is missing or unreachable", async () => {
      stubDesktopRequest({ detail: "not found" }, 404);

      const state = await verifyBackendVersion();

      expect(state.kind).toBe("unavailable");
      expect(getVersionCheckState()).toMatchObject({ kind: "unavailable" });
    });

    it.each([401, 403])("opens external auth recovery on HTTP %s", async (status) => {
      stubDesktopRequest({ detail: "authentication required" }, status);

      const state = await verifyBackendVersion(undefined, { connectionMode: "remote" });

      expect(state).toEqual({
        kind: "deferred",
        reason: "external-backend-auth-required",
      });
      expect(() => assertCompatible()).not.toThrow();
    });

    it("opens external connection recovery for a machine-readable reachability failure", async () => {
      const error = Object.assign(new Error("Dashboard not reachable"), {
        code: "dashboard_unreachable",
        kind: "dashboard",
      });
      stubDesktopRequestError(error);

      const state = await verifyBackendVersion(undefined, { connectionMode: "local" });

      expect(state).toEqual({
        kind: "deferred",
        reason: "external-backend-unreachable",
      });
      expect(() => assertCompatible()).not.toThrow();
    });

    it("keeps the same reachability failure fatal for managed runtime", async () => {
      const error = Object.assign(new Error("Dashboard not reachable"), {
        code: "dashboard_unreachable",
        kind: "dashboard",
      });
      stubDesktopRequestError(error);

      const state = await verifyBackendVersion(undefined, { connectionMode: "managed" });

      expect(state).toMatchObject({
        kind: "unavailable",
        reason: "Dashboard not reachable",
      });
    });

    it("keeps a reachable external backend without /api/version fatal", async () => {
      stubDesktopRequest({ detail: "not found" }, 404);

      const state = await verifyBackendVersion(undefined, { connectionMode: "remote" });

      expect(state).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("HTTP 404") });
    });

    it("preserves external recovery semantics when an unchecked request triggers revalidation", async () => {
      const fatalErrorAndExit = vi.fn(() => new Promise<never>(() => {}));
      vi.stubGlobal("window", {
        __TAURI_INTERNALS__: {},
        __HERMES_RUNTIME__: {
          platform: "tauri",
          connectionMode: "remote",
          apiBaseUrl: "https://remote.example.com",
        },
        hermesDesktop: { windowType: "tauri", fatalErrorAndExit },
        location: { href: "hermesui://localhost/index.html", protocol: "hermesui:" },
      });
      stubDesktopRequest({ error: "unauthenticated" }, 401);

      expect(() => assertCompatible()).toThrow("backend version check has not completed");
      await vi.waitFor(() => {
        expect(getVersionCheckState()).toEqual({
          kind: "deferred",
          reason: "external-backend-auth-required",
        });
      });
      expect(fatalErrorAndExit).not.toHaveBeenCalled();
    });

    it("assertCompatible throws on mismatch and invokes fatal dialog", async () => {
      const fatalErrorAndExit = vi.fn(() => new Promise<never>(() => {}));
      vi.stubGlobal("window", {
        __TAURI_INTERNALS__: {},
        __HERMES_RUNTIME__: { platform: "tauri", apiBaseUrl: "http://127.0.0.1:9120" },
        hermesDesktop: { windowType: "tauri", fatalErrorAndExit },
        location: { href: "http://localhost:9545/", protocol: "http:" },
      });

      stubDesktopRequest({ version: "0.18.0", name: "hermes-agent" });
      await verifyBackendVersion();

      expect(() => assertCompatible()).toThrow(/backend version mismatch/);
      expect(fatalErrorAndExit).toHaveBeenCalledWith({
        title: "版本不匹配",
        message: expect.stringContaining("当前 Desktop 兼容的 Core"),
      });
    });

    it("assertCompatible throws when backend version is unavailable", async () => {
      const fatalErrorAndExit = vi.fn(() => new Promise<never>(() => {}));
      vi.stubGlobal("window", {
        __TAURI_INTERNALS__: {},
        __HERMES_RUNTIME__: { platform: "tauri", apiBaseUrl: "http://127.0.0.1:9120" },
        hermesDesktop: { windowType: "tauri", fatalErrorAndExit },
        location: { href: "http://localhost:9545/", protocol: "http:" },
      });

      stubDesktopRequest({ detail: "not found" }, 404);
      await verifyBackendVersion();

      expect(() => assertCompatible()).toThrow(/backend version unavailable/);
      expect(fatalErrorAndExit).toHaveBeenCalledWith({
        title: "版本验证失败",
        message: expect.stringContaining("无法验证后端版本"),
      });
    });

    it("resetVersionCheck resets state to unchecked", async () => {
      stubDesktopRequest({ version: EXPECTED_BACKEND_VERSION, name: "hermes-agent" });
      await verifyBackendVersion();
      expect(getVersionCheckState().kind).toBe("ok");

      resetVersionCheck();

      expect(getVersionCheckState()).toEqual({ kind: "unchecked" });
    });

    it("allows recovery UI calls while the managed runtime is intentionally offline", () => {
      deferBackendVersionCheckForOfflineRuntime();

      expect(getVersionCheckState()).toEqual({
        kind: "deferred",
        reason: "managed-runtime-offline",
      });
      expect(() => assertCompatible()).not.toThrow();
    });

    it("prefers the recorded runtime kernel version over the baked constant", async () => {
      recordRuntimeKernelVersion("0.20.1");
      expect(expectedBackendVersion()).toBe("0.20.1");
      stubDesktopRequest({ version: "0.20.1", name: "hermes-agent" });

      const state = await verifyBackendVersion();

      expect(state.kind).toBe("ok");
      expect(state).toMatchObject({ backendVersion: "0.20.1" });
    });

    it("keeps the managed runtime install record as an exact integrity check", async () => {
      recordRuntimeKernelVersion("0.20.0");
      stubDesktopRequest({ version: "0.20.1", name: "hermes-agent" });

      const state = await verifyBackendVersion(undefined, { connectionMode: "managed" });

      expect(state).toMatchObject({
        kind: "mismatch",
        backendVersion: "0.20.1",
        expectedVersion: "0.20.0",
      });
    });

    it("does not fall back to a CORS-bound browser fetch when the IPC bridge is missing", async () => {
      const state = await verifyBackendVersion();

      expect(state).toEqual({ kind: "unavailable", reason: "desktop IPC bridge unavailable" });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("falls back to the baked constant when no kernel version is recorded", () => {
      resetVersionCheck();
      expect(expectedBackendVersion()).toBe(EXPECTED_BACKEND_VERSION);
    });

    it("resetVersionCheck clears the recorded kernel version", () => {
      recordRuntimeKernelVersion("0.20.1");
      resetVersionCheck();
      expect(expectedBackendVersion()).toBe(EXPECTED_BACKEND_VERSION);
    });
  });
});
