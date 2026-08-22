// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJSON } from "./transport";
import { clearDashboardRegistry, registerDashboardHandler } from "./dashboard-router";

let originalFetch: typeof globalThis.fetch;

describe("dashboard local-first transport intercept", () => {
  beforeEach(() => {
    clearDashboardRegistry();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{"should":"not be called"}', { status: 500 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete window.__HERMES_RUNTIME__;
    clearDashboardRegistry();
  });

  it("fetchJSON calls a registered local handler in managed mode", async () => {
    window.__HERMES_RUNTIME__ = { platform: "web", connectionMode: "managed" };
    registerDashboardHandler("/api/status", () => ({ ok: true, local: true }));

    const result = await fetchJSON<{ ok: boolean; local: boolean }>("/api/status");

    expect(result).toEqual({ ok: true, local: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fetchJSON falls back to fetch when no local handler is registered", async () => {
    window.__HERMES_RUNTIME__ = { platform: "web", connectionMode: "managed" };
    globalThis.fetch = vi.fn(async () =>
      new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const result = await fetchJSON<{ ok: boolean }>("/api/not-local");
    expect(result).toEqual({ ok: true });
  });

  it("does not invoke local handlers in attached (non-managed) mode", async () => {
    window.__HERMES_RUNTIME__ = { platform: "web", connectionMode: "remote" };
    registerDashboardHandler("/api/status", () => ({ local: true }));

    globalThis.fetch = vi.fn(async () =>
      new Response('{"remote":true}', { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const result = await fetchJSON<{ remote?: boolean; local?: boolean }>("/api/status");
    expect(result).toEqual({ remote: true });
  });
});
