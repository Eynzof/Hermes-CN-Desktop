import { describe, expect, it } from "vitest";
import { createStatusRoutes } from "./status";
import type { DashboardStatus } from "./status";
import { DashboardRouter } from "../router";

async function get(router: DashboardRouter, path: string) {
  return router.handle({ path, method: "GET", body: null, headers: {} });
}

describe("createStatusRoutes", () => {
  it("registers /api/status with defaults", async () => {
    const router = createStatusRoutes(new DashboardRouter());
    await expect(get(router, "/api/status")).resolves.toEqual({
      ok: true,
      platform: "desktop",
      version: "0.0.0",
      connection_mode: "managed",
    });
  });

  it("reflects the configured version and connection mode", async () => {
    const router = createStatusRoutes(new DashboardRouter(), {
      version: "0.8.0-rc4",
      connectionMode: "local",
    });
    const result = (await get(router, "/api/status")) as DashboardStatus;
    expect(result.version).toBe("0.8.0-rc4");
    expect(result.connection_mode).toBe("local");
    expect(result.ok).toBe(true);
    expect(result.platform).toBe("desktop");
  });

  it("supports every connection mode variant", async () => {
    for (const mode of ["managed", "local", "remote"] as const) {
      const router = createStatusRoutes(new DashboardRouter(), {
        version: "1.0.0",
        connectionMode: mode,
      });
      const result = (await get(router, "/api/status")) as DashboardStatus;
      expect(result.connection_mode).toBe(mode);
    }
  });

  it("registers /api/health", async () => {
    const router = createStatusRoutes(new DashboardRouter());
    await expect(get(router, "/api/health")).resolves.toEqual({ ok: true });
  });

  it("registers /api/version with version and platform", async () => {
    const router = createStatusRoutes(new DashboardRouter(), {
      version: "0.8.0-rc4",
      connectionMode: "remote",
    });
    await expect(get(router, "/api/version")).resolves.toEqual({
      version: "0.8.0-rc4",
      platform: "desktop",
    });
  });

  it("does not register unrelated routes", async () => {
    const router = createStatusRoutes(new DashboardRouter());
    expect(router.resolve("/api/status", "POST")).toBeUndefined();
    expect(router.resolve("/api/nonexistent")).toBeUndefined();
  });
});
