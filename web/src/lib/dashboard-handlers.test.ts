import { beforeEach, describe, expect, it } from "vitest";
import { __resetUiStoreForTests } from "./ui-store";
import {
  dashboardConfigHandler,
  dashboardPairingHandler,
  dashboardStatusHandler,
  dashboardWebhooksHandler,
  registerLocalDashboardHandlers,
} from "./dashboard-handlers";
import { clearDashboardRegistry, getDashboardHandler } from "./dashboard-router";

describe("dashboard-handlers", () => {
  beforeEach(() => {
    clearDashboardRegistry();
    __resetUiStoreForTests({});
  });

  it("returns a managed-mode status payload", () => {
    const result = dashboardStatusHandler();
    expect(result.ok).toBe(true);
    expect(result.connection_mode).toBe("managed");
    expect(typeof result.version).toBe("string");
  });

  it("returns an empty config scaffold", () => {
    const result = dashboardConfigHandler();
    expect(result).toHaveProperty("config");
  });

  it("returns empty webhooks and pairing collections", () => {
    expect(dashboardWebhooksHandler()).toEqual({ webhooks: [] });
    expect(dashboardPairingHandler()).toEqual({ pairings: [] });
  });

  it("registers all baseline routes", () => {
    registerLocalDashboardHandlers();
    expect(getDashboardHandler("/api/status")).toBeDefined();
    expect(getDashboardHandler("/api/config")).toBeDefined();
    expect(getDashboardHandler("/api/webhooks")).toBeDefined();
    expect(getDashboardHandler("/api/pairing")).toBeDefined();
  });

  it("registers auth routes", () => {
    registerLocalDashboardHandlers();
    expect(getDashboardHandler("/api/auth/providers")).toBeDefined();
    expect(getDashboardHandler("/api/auth/me")).toBeDefined();
    expect(getDashboardHandler("/api/auth/password-login", "POST")).toBeDefined();
    expect(getDashboardHandler("/api/auth/token-login", "POST")).toBeDefined();
    expect(getDashboardHandler("/api/auth/logout", "POST")).toBeDefined();
    expect(getDashboardHandler("/api/auth/refresh", "POST")).toBeDefined();
  });
});
