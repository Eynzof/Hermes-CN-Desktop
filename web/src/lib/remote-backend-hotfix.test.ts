import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertCompatible, getVersionCheckState, recordRuntimeKernelVersion, resetVersionCheck, verifyBackendVersion } from "./version-check";

function reply(status: number, body: unknown) {
  return { ok: status === 200, status, statusText: String(status), headers: {}, body: JSON.stringify(body) };
}

const request = vi.fn();
beforeEach(() => {
  resetVersionCheck();
  request.mockReset();
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {},
    __HERMES_RUNTIME__: { platform: "tauri", connectionMode: "remote", apiBaseUrl: "http://gateway.test:9119" },
    hermesDesktop: { windowType: "tauri", request },
    location: { href: "http://hermesui.localhost/", protocol: "http:" },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("official CLI remote compatibility regression", () => {
  it.each(["v0.21.0", "0.21.0-cn.8"])("preserves an existing compatible Core version %s", async (version) => {
    request.mockResolvedValue(reply(200, { version }));
    expect(await verifyBackendVersion()).toEqual({ kind: "ok", backendVersion: version });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["0.21.2", "0.21.5", "0.21.6", "0.22.0"])("loads official %s without /api/version", async (version) => {
    request.mockResolvedValueOnce(reply(404, { detail: "No such API endpoint: /api/version" }))
      .mockResolvedValueOnce(reply(200, { version, gateway_running: true, overall: "ok" }));
    recordRuntimeKernelVersion("0.21.0");
    expect(await verifyBackendVersion(undefined, { connectionMode: "remote" })).toEqual({ kind: "ok", backendVersion: version });
    expect(request.mock.calls.map(([input]) => input.path)).toEqual(["/api/version", "/api/status"]);
    expect(() => assertCompatible()).not.toThrow();
  });

  it("uses the same official contract for a local CLI connection", async () => {
    request.mockResolvedValueOnce(reply(404, {})).mockResolvedValueOnce(reply(200, { version: "0.22.0" }));
    expect(await verifyBackendVersion(undefined, { connectionMode: "local" })).toEqual({ kind: "ok", backendVersion: "0.22.0" });
  });

  it("uses /api/status through the non-Tauri transport as well", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    (window as any).__HERMES_RUNTIME__.platform = "electron";
    (window as any).hermesDesktop.windowType = "electron";
    const fetch = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: "0.22.0" })));
    vi.stubGlobal("fetch", fetch);
    expect(await verifyBackendVersion("http://gateway.test:9119/")).toEqual({ kind: "ok", backendVersion: "0.22.0" });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["http://gateway.test:9119/api/version", "http://gateway.test:9119/api/status"]);
  });

  it("keeps authentication recovery when the status endpoint needs login", async () => {
    request.mockResolvedValueOnce(reply(404, {})).mockResolvedValueOnce(reply(401, {}));
    expect(await verifyBackendVersion()).toEqual({ kind: "deferred", reason: "external-backend-auth-required" });
  });

  it.each([401, 403])("preserves authentication recovery on HTTP %s without consulting public status", async (status) => {
    request.mockResolvedValue(reply(status, { detail: "Login required" }));
    expect(await verifyBackendVersion()).toEqual({ kind: "deferred", reason: "external-backend-auth-required" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { version: "0.23.0" }])("keeps recovery reachable for unsupported status response %j", async (status) => {
    request.mockResolvedValueOnce(reply(404, {})).mockResolvedValueOnce(reply(200, status));
    expect(await verifyBackendVersion()).toMatchObject({ kind: "deferred", reason: "version" in status ? "external-backend-incompatible" : "external-backend-version-unavailable" });
    expect(() => assertCompatible()).not.toThrow();
  });

  it("does not turn HTTP 500 into a compatible connection", async () => {
    request.mockResolvedValue(reply(500, { detail: "backend failed" }));
    expect(await verifyBackendVersion()).toMatchObject({ kind: "deferred", reason: "external-backend-version-unavailable", detail: expect.stringContaining("500") });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps managed runtime version and endpoint integrity strict", async () => {
    request.mockResolvedValue(reply(404, {}));
    expect(await verifyBackendVersion(undefined, { connectionMode: "managed" })).toMatchObject({ kind: "unavailable" });
    expect(request).toHaveBeenCalledTimes(1);
    resetVersionCheck();
    recordRuntimeKernelVersion("0.21.0");
    request.mockResolvedValue(reply(200, { version: "0.22.0" }));
    expect(await verifyBackendVersion(undefined, { connectionMode: "managed" })).toMatchObject({ kind: "mismatch" });
    expect(getVersionCheckState().kind).toBe("mismatch");
  });
});
