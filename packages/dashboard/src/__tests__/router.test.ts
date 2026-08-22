import { describe, expect, it } from "vitest";
import { DashboardRouter } from "../router";

describe("DashboardRouter", () => {
  it("registers and resolves exact routes", () => {
    const router = new DashboardRouter();
    router.register("/api/status", () => ({ ok: true }));
    const handler = router.resolve("/api/status", "GET");
    expect(handler).toBeDefined();
    expect(handler?.({ path: "/api/status", method: "GET", body: null, headers: {} })).toEqual({
      ok: true,
    });
  });

  it("returns undefined for unregistered routes", () => {
    const router = new DashboardRouter();
    expect(router.resolve("/api/missing", "GET")).toBeUndefined();
  });

  it("matches prefix routes", () => {
    const router = new DashboardRouter();
    router.registerPrefix("/api/memory", () => ({ memory: true }));
    const handler = router.resolve("/api/memory/providers/foo/status", "GET");
    expect(handler).toBeDefined();
  });

  it("returns a 404 from handle when no route matches", async () => {
    const router = new DashboardRouter();
    const result = await router.handle({
      path: "/api/missing",
      method: "GET",
      body: null,
      headers: {},
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("can clear all routes", () => {
    const router = new DashboardRouter();
    router.register("/api/status", () => ({ ok: true }));
    router.clear();
    expect(router.resolve("/api/status", "GET")).toBeUndefined();
  });
});
