/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import { runDashboardSmoke, type SmokeProbes, type DashboardSmokeCheck } from "./dashboard-smoke";

function makeProbe(results: Record<string, DashboardSmokeCheck>): SmokeProbes {
  return {
    portProbe: vi.fn().mockResolvedValue(results.port),
    statusProbe: vi.fn().mockResolvedValue(results.status),
    openapiProbe: vi.fn().mockResolvedValue(results.openapi),
    wsHandshakeProbe: vi.fn().mockResolvedValue(results.ws),
    endpointChecks: vi.fn().mockResolvedValue(results.endpoints),
  };
}

const ok = (id: string, label: string): DashboardSmokeCheck => ({
  id,
  label,
  ok: true,
  status: "ok",
  latencyMs: 10,
});

const fail = (id: string, label: string): DashboardSmokeCheck => ({
  id,
  label,
  ok: false,
  status: "failing",
  latencyMs: 10,
  detail: "simulated failure",
});

describe("runDashboardSmoke", () => {
  it("reports ok when all probes pass", async () => {
    const probes = makeProbe({
      port: ok("port", "Dashboard TCP port reachable"),
      status: ok("status", "/api/status responds"),
      openapi: ok("openapi", "/openapi.json reachable"),
      ws: ok("ws", "/api/ws handshake"),
      endpoints: ok("endpoints", "Fork-specific endpoints present"),
    });
    const result = await runDashboardSmoke("http://127.0.0.1:9119", { probes });
    expect(result.ok).toBe(true);
    expect(result.overall).toBe("ok");
    expect(result.checks).toHaveLength(5);
    expect(result.components.gateway?.ok).toBe(true);
    expect(result.components.dashboard?.ok).toBe(true);
  });

  it("reports failing when any probe fails", async () => {
    const probes = makeProbe({
      port: ok("port", "Dashboard TCP port reachable"),
      status: fail("status", "/api/status responds"),
      openapi: ok("openapi", "/openapi.json reachable"),
      ws: ok("ws", "/api/ws handshake"),
      endpoints: ok("endpoints", "Fork-specific endpoints present"),
    });
    const result = await runDashboardSmoke("http://127.0.0.1:9119", { probes });
    expect(result.ok).toBe(false);
    expect(result.overall).toBe("failing");
    expect(result.components.gateway?.ok).toBe(false);
  });

  it("reports degraded when endpoint check is degraded", async () => {
    const probes = makeProbe({
      port: ok("port", "Dashboard TCP port reachable"),
      status: ok("status", "/api/status responds"),
      openapi: ok("openapi", "/openapi.json reachable"),
      ws: ok("ws", "/api/ws handshake"),
      endpoints: {
        id: "endpoints",
        label: "Fork-specific endpoints present",
        ok: true,
        status: "degraded",
        latencyMs: 10,
        detail: "partial",
      },
    });
    const result = await runDashboardSmoke("http://127.0.0.1:9119", { probes });
    expect(result.ok).toBe(false);
    expect(result.overall).toBe("degraded");
  });
});
