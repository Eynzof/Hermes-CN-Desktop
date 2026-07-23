import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runtime } from "./runtime";

beforeEach(() => {
  (globalThis as any).window = {
    __HERMES_RUNTIME__: {
      platform: "tauri",
      apiBaseUrl: "http://old",
      gatewayUrl: "ws://old/api/ws",
      sessionToken: "old-token",
      currentProfile: "default",
      desktopBuildFlavor: "standard",
    },
  };
});

describe("desktop build flavor", () => {
  it("defaults to standard and identifies the strict shell flavor", () => {
    expect(runtime.getDesktopBuildFlavor()).toBe("standard");
    expect(runtime.isShellBuild()).toBe(false);

    window.__HERMES_RUNTIME__!.desktopBuildFlavor = "shell";
    expect(runtime.getDesktopBuildFlavor()).toBe("shell");
    expect(runtime.isShellBuild()).toBe(true);
  });
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe("runtime.applyConfigMigrationResult", () => {
  it("updates runtime URLs, token and active profile after migration", () => {
    runtime.applyConfigMigrationResult({
      ok: true,
      targetProfileName: "imported",
      apiBaseUrl: "http://new",
      gatewayUrl: "ws://new/api/ws",
      sessionToken: "new-token",
      importedEntries: ["config.yaml"],
      warnings: [],
    });

    expect(window.__HERMES_RUNTIME__).toMatchObject({
      apiBaseUrl: "http://new",
      dashboardApiBaseUrl: "http://new",
      gatewayUrl: "ws://new/api/ws",
      sessionToken: "new-token",
      currentProfile: "imported",
    });
  });

  it("keeps dev relative API mode while remembering the dashboard origin", () => {
    delete window.__HERMES_RUNTIME__?.apiBaseUrl;

    runtime.applyConfigMigrationResult({
      ok: true,
      targetProfileName: "imported",
      apiBaseUrl: "http://new",
      gatewayUrl: "ws://new/api/ws",
      sessionToken: "new-token",
      importedEntries: ["config.yaml"],
      warnings: [],
    });

    expect(window.__HERMES_RUNTIME__).toMatchObject({
      dashboardApiBaseUrl: "http://new",
      gatewayUrl: "ws://new/api/ws",
      sessionToken: "new-token",
      currentProfile: "imported",
    });
    expect(window.__HERMES_RUNTIME__?.apiBaseUrl).toBeUndefined();
  });

  it("ignores failed migration results", () => {
    runtime.applyConfigMigrationResult({
      ok: false,
      targetProfileName: "imported",
      importedEntries: [],
      warnings: [],
      error: "failed",
    });

    expect(window.__HERMES_RUNTIME__?.currentProfile).toBe("default");
  });
});

describe("runtime.applyBackupImportResult", () => {
  it("updates runtime URLs, token and active profile after backup import", () => {
    runtime.applyBackupImportResult({
      ok: true,
      canceled: false,
      targetProfileName: "restored-default",
      apiBaseUrl: "http://new",
      gatewayUrl: "ws://new/api/ws",
      sessionToken: "new-token",
      importedEntries: ["config.yaml", "sessions"],
      fileCount: 2,
      totalBytes: 128,
      warnings: [],
    });

    expect(window.__HERMES_RUNTIME__).toMatchObject({
      apiBaseUrl: "http://new",
      dashboardApiBaseUrl: "http://new",
      gatewayUrl: "ws://new/api/ws",
      sessionToken: "new-token",
      currentProfile: "restored-default",
    });
  });

  it("ignores failed backup imports", () => {
    runtime.applyBackupImportResult({
      ok: false,
      canceled: false,
      targetProfileName: "restored-default",
      importedEntries: [],
      fileCount: 0,
      totalBytes: 0,
      warnings: [],
      error: "failed",
    });

    expect(window.__HERMES_RUNTIME__?.currentProfile).toBe("default");
  });

  it("refreshes connection but keeps profile after recovered backup import failures", () => {
    runtime.applyBackupImportResult({
      ok: false,
      canceled: false,
      targetProfileName: "restored-default",
      apiBaseUrl: "http://recovered",
      gatewayUrl: "ws://recovered/api/ws",
      sessionToken: "recovered-token",
      importedEntries: ["config.yaml"],
      fileCount: 1,
      totalBytes: 64,
      warnings: [],
      error: "target failed",
      recoveredPreviousProfile: true,
    });

    expect(window.__HERMES_RUNTIME__).toMatchObject({
      apiBaseUrl: "http://recovered",
      dashboardApiBaseUrl: "http://recovered",
      gatewayUrl: "ws://recovered/api/ws",
      sessionToken: "recovered-token",
      currentProfile: "default",
    });
  });
});

describe("managed runtime control state", () => {
  it("adopts guide and lifecycle changes without inventing a backend URL", () => {
    runtime.applyRuntimeControlResult({
      ok: true,
      guideState: "deferred",
      desiredState: "uninstalled",
      lifecycleState: "uninstalled",
      installed: false,
      running: false,
      backendReady: false,
    });

    expect(window.__HERMES_RUNTIME__).toMatchObject({
      backendReady: false,
      guideState: "deferred",
      managedRuntimeDesiredState: "uninstalled",
      managedRuntimeLifecycleState: "uninstalled",
    });
    expect(window.__HERMES_RUNTIME__?.apiBaseUrl).toBe("http://old");
  });
});
