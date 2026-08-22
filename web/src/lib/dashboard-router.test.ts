import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDashboardRegistry,
  createDashboardRouter,
  getDashboardHandler,
  listDashboardRoutes,
  registerDashboardHandler,
  registerDashboardPrefixHandler,
  unregisterDashboardHandler,
} from "./dashboard-router";

const ctx = { path: "/", method: "GET", body: undefined, headers: {} };

describe("dashboard-router", () => {
  beforeEach(() => {
    clearDashboardRegistry();
  });

  it("registers and retrieves a GET handler", () => {
    const handler = () => ({ ok: true });
    registerDashboardHandler("/api/status", handler);
    expect(getDashboardHandler("/api/status")?.(ctx)).toEqual({ ok: true });
  });

  it("differentiates methods for the same path", () => {
    registerDashboardHandler("/api/config", () => ({ method: "GET" }));
    registerDashboardHandler("/api/config", () => ({ method: "POST" }), "POST");
    expect(getDashboardHandler("/api/config")?.(ctx)).toEqual({ method: "GET" });
    expect(getDashboardHandler("/api/config", "POST")?.(ctx)).toEqual({ method: "POST" });
  });

  it("supports bulk registration via createDashboardRouter", () => {
    createDashboardRouter({
      "GET /api/a": () => "a",
      "POST /api/b": () => "b",
      "/api/c": () => "c",
    });
    expect(getDashboardHandler("/api/a")?.(ctx)).toBe("a");
    expect(getDashboardHandler("/api/b", "POST")?.(ctx)).toBe("b");
    expect(getDashboardHandler("/api/c")?.(ctx)).toBe("c");
  });

  it("unregisters handlers", () => {
    registerDashboardHandler("/api/x", () => "x");
    unregisterDashboardHandler("/api/x");
    expect(getDashboardHandler("/api/x")).toBeUndefined();
  });

  it("lists registered routes", () => {
    registerDashboardHandler("/api/a", () => "a", "GET");
    registerDashboardHandler("/api/b", () => "b", "POST");
    expect(listDashboardRoutes()).toEqual([
      { method: "GET", path: "/api/a", kind: "exact" },
      { method: "POST", path: "/api/b", kind: "exact" },
    ]);
  });

  it("falls back to a prefix handler", () => {
    registerDashboardPrefixHandler("/api/memory/providers", () => "memory", "GET");
    expect(getDashboardHandler("/api/memory/providers/foo/status", "GET")?.(ctx)).toBe("memory");
    expect(getDashboardHandler("/api/memory/providers", "GET")?.(ctx)).toBe("memory");
    expect(getDashboardHandler("/api/other", "GET")).toBeUndefined();
  });
});
