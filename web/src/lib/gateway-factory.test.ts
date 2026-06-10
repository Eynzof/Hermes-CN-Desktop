import { describe, expect, it, vi } from "vitest";

// Reload the factory module each test so the singleton cache resets.
async function loadFactory() {
  vi.resetModules();
  return await import("./gateway-client");
}

describe("getGatewayClient", () => {
  it("returns a WebSocket GatewayClient (the only transport)", async () => {
    const mod = await loadFactory();
    const client = mod.getGatewayClient();
    expect(client.constructor.name).toBe("GatewayClient");
  });

  it("returns the same instance on repeat calls (singleton)", async () => {
    const mod = await loadFactory();
    expect(mod.getGatewayClient()).toBe(mod.getGatewayClient());
  });
});
