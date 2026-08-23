import { describe, expect, it, vi } from "vitest";
import { DashboardRouter } from "./router";
import type { DashboardRequestContext } from "./router";

function ctx(overrides: Partial<DashboardRequestContext> = {}): DashboardRequestContext {
  return { path: "/api/test", method: "GET", body: null, headers: {}, ...overrides };
}

/**
 * Co-located deep coverage for the router. The pre-existing
 * `src/__tests__/router.test.ts` covers the basics; this suite adds method
 * dispatch, prefix boundaries, registration bookkeeping and async handlers.
 */
describe("DashboardRouter", () => {
  it("registers and resolves a handler for a specific method", async () => {
    const router = new DashboardRouter();
    const get = vi.fn(() => ({ via: "get" }));
    const post = vi.fn(() => ({ via: "post" }));
    router.register("/api/x", get, "GET");
    router.register("/api/x", post, "POST");

    expect(await router.handle(ctx({ path: "/api/x", method: "GET" }))).toEqual({ via: "get" });
    expect(await router.handle(ctx({ path: "/api/x", method: "POST" }))).toEqual({ via: "post" });
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("is method case-insensitive on both registration and dispatch", async () => {
    const router = new DashboardRouter();
    const handler = vi.fn(() => ({ ok: true }));
    router.register("/api/x", handler, "post");
    expect(router.resolve("/api/x", "POST")).toBe(handler);
    expect(router.resolve("/api/x", "post")).toBe(handler);
  });

  it("defaults the method to GET", async () => {
    const router = new DashboardRouter();
    const handler = vi.fn(() => ({ ok: true }));
    router.register("/api/x", handler);
    expect(router.resolve("/api/x")).toBe(handler);
    expect(router.resolve("/api/x", "GET")).toBe(handler);
    expect(router.resolve("/api/x", "POST")).toBeUndefined();
  });

  it("returns undefined when the path exists but the method does not", () => {
    const router = new DashboardRouter();
    router.register("/api/x", () => ({}), "GET");
    expect(router.resolve("/api/x", "DELETE")).toBeUndefined();
  });

  it("resolves prefix routes for nested paths only (boundary-aware)", () => {
    const router = new DashboardRouter();
    router.registerPrefix("/api/memory", () => ({ memory: true }));
    expect(router.resolve("/api/memory")).toBeDefined();
    expect(router.resolve("/api/memory/providers/foo/status")).toBeDefined();
    // Sibling path must NOT match the prefix.
    expect(router.resolve("/api/memory2")).toBeUndefined();
    expect(router.resolve("/api/memories")).toBeUndefined();
  });

  it("prefix resolution is method-scoped", () => {
    const router = new DashboardRouter();
    router.registerPrefix("/api/memory", () => ({}), "POST");
    expect(router.resolve("/api/memory/x", "POST")).toBeDefined();
    expect(router.resolve("/api/memory/x", "GET")).toBeUndefined();
  });

  it("prefers an exact match over a registered prefix", () => {
    const router = new DashboardRouter();
    router.registerPrefix("/api/memory", () => ({ kind: "prefix" }));
    router.register("/api/memory", () => ({ kind: "exact" }));
    expect(router.resolve("/api/memory")).toBeDefined();
    expect(router.resolve("/api/memory")!(ctx())).toEqual({ kind: "exact" });
  });

  it("uses the first matching prefix handler", () => {
    const router = new DashboardRouter();
    router.registerPrefix("/api", () => ({ which: "api" }));
    router.registerPrefix("/api/deep", () => ({ which: "deep" }));
    expect(router.resolve("/api/deep/x")!(ctx())).toEqual({ which: "api" });
  });

  it("handle passes the request context through to async handlers", async () => {
    const router = new DashboardRouter();
    const handler = vi.fn(async (c: DashboardRequestContext) => ({
      echo: c.path,
      method: c.method,
      body: c.body,
      header: c.headers["x-test"],
    }));
    router.register("/api/echo", handler);
    const result = await router.handle(
      ctx({ path: "/api/echo", body: { a: 1 }, headers: { "x-test": "yes" } }),
    );
    expect(result).toEqual({
      echo: "/api/echo",
      method: "GET",
      body: { a: 1 },
      header: "yes",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handle returns a 404-shaped result with method and path", async () => {
    const router = new DashboardRouter();
    const result = await router.handle(ctx({ path: "/api/nope", method: "POST" }));
    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "no handler for POST /api/nope",
    });
  });

  it("unregister removes only the exact method handler", () => {
    const router = new DashboardRouter();
    router.register("/api/x", () => ({ a: 1 }), "GET");
    router.register("/api/x", () => ({ a: 2 }), "POST");
    router.unregister("/api/x", "GET");
    expect(router.resolve("/api/x", "GET")).toBeUndefined();
    expect(router.resolve("/api/x", "POST")).toBeDefined();
  });

  it("routes() snapshots exact and prefix registrations", () => {
    const router = new DashboardRouter();
    router.register("/api/status", () => ({}));
    router.register("/api/login", () => ({}), "POST");
    router.registerPrefix("/api/memory", () => ({}));
    router.registerPrefix("/api/ws", () => ({}), "WS");
    expect(router.routes()).toEqual([
      { method: "GET", path: "/api/status", kind: "exact" },
      { method: "POST", path: "/api/login", kind: "exact" },
      { method: "GET", path: "/api/memory", kind: "prefix" },
      { method: "WS", path: "/api/ws", kind: "prefix" },
    ]);
  });

  it("register and registerPrefix are chainable", () => {
    const router = new DashboardRouter();
    expect(
      router
        .register("/api/a", () => ({}))
        .registerPrefix("/api/b", () => ({}))
        .unregister("/api/a"),
    ).toBe(router);
  });

  it("clear removes exact and prefix handlers", () => {
    const router = new DashboardRouter();
    router.register("/api/a", () => ({}));
    router.registerPrefix("/api/b", () => ({}));
    router.clear();
    expect(router.resolve("/api/a")).toBeUndefined();
    expect(router.resolve("/api/b/x")).toBeUndefined();
    expect(router.routes()).toEqual([]);
  });
});
