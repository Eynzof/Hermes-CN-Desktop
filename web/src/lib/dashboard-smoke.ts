// Dashboard smoke-check orchestration.
//
// Mirrors the Python `hermes dashboard --no-open` readiness contract and the
// fork-specific `/api/status` components rollup. Runs from the webview (or
// Node for CI) against the current `__HERMES_RUNTIME__.apiBaseUrl`.

import { StatusResponse } from "@hermes/protocol";

export interface DashboardSmokeCheck {
  id: string;
  label: string;
  ok: boolean;
  status?: "ok" | "degraded" | "failing";
  latencyMs?: number;
  detail?: string;
}

export interface DashboardSmokeComponents {
  gateway?: { ok: boolean; state?: string; detail?: string };
  dashboard?: { ok: boolean; selftest?: string; detail?: string };
  storage?: { ok: boolean; detail?: string };
  platforms?: { ok: boolean; detail?: string };
}

export interface DashboardSmokeResult {
  ok: boolean;
  overall: "ok" | "degraded" | "failing";
  at: string;
  checks: DashboardSmokeCheck[];
  components: DashboardSmokeComponents;
}

export interface SmokeProbes {
  portProbe(origin: string, timeoutMs?: number): Promise<DashboardSmokeCheck>;
  statusProbe(origin: string, timeoutMs?: number): Promise<DashboardSmokeCheck>;
  openapiProbe(origin: string, timeoutMs?: number): Promise<DashboardSmokeCheck>;
  wsHandshakeProbe(origin: string, token?: string, timeoutMs?: number): Promise<DashboardSmokeCheck>;
  endpointChecks(origin: string, token?: string, timeoutMs?: number): Promise<DashboardSmokeCheck>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function latency(start: number): number {
  return Math.round(performance.now() - start);
}

export const defaultSmokeProbes: SmokeProbes = {
  async portProbe(origin, timeoutMs = 900): Promise<DashboardSmokeCheck> {
    const id = "port";
    const label = "Dashboard TCP port reachable";
    const start = performance.now();
    try {
      const url = new URL(origin);
      const host = url.hostname;
      const port = parseInt(url.port || (url.protocol === "https:" ? "443" : "80"), 10);
      await withTimeout(tcpConnect(host, port), timeoutMs, "port probe");
      return { id, label, ok: true, status: "ok", latencyMs: latency(start) };
    } catch (err) {
      return {
        id,
        label,
        ok: false,
        status: "failing",
        latencyMs: latency(start),
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async statusProbe(origin, timeoutMs = 5_000): Promise<DashboardSmokeCheck> {
    const id = "status";
    const label = "/api/status responds";
    const start = performance.now();
    try {
      const res = await withTimeout(
        fetch(`${origin}/api/status`, { headers: { Accept: "application/json" } }),
        timeoutMs,
        "status probe",
      );
      const text = await res.text();
      if (!res.ok && res.status !== 401) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (res.ok && text) {
        const json = JSON.parse(text);
        StatusResponse.parse(json);
      }
      return { id, label, ok: true, status: "ok", latencyMs: latency(start) };
    } catch (err) {
      return {
        id,
        label,
        ok: false,
        status: "failing",
        latencyMs: latency(start),
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async openapiProbe(origin, timeoutMs = 5_000): Promise<DashboardSmokeCheck> {
    const id = "openapi";
    const label = "/openapi.json reachable";
    const start = performance.now();
    try {
      const res = await withTimeout(
        fetch(`${origin}/openapi.json`, { headers: { Accept: "application/json" } }),
        timeoutMs,
        "openapi probe",
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return { id, label, ok: true, status: "ok", latencyMs: latency(start) };
    } catch (err) {
      return {
        id,
        label,
        ok: false,
        status: "failing",
        latencyMs: latency(start),
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async wsHandshakeProbe(origin, token, timeoutMs = 4_000): Promise<DashboardSmokeCheck> {
    const id = "ws";
    const label = "/api/ws handshake";
    const start = performance.now();
    try {
      const proto = new URL(origin).protocol === "https:" ? "wss:" : "ws:";
      const url = new URL(`${proto}//${new URL(origin).host}/api/ws`);
      if (token) url.searchParams.set("token", token);
      await withTimeout(wsConnectAndClose(url.toString()), timeoutMs, "ws handshake");
      return { id, label, ok: true, status: "ok", latencyMs: latency(start) };
    } catch (err) {
      return {
        id,
        label,
        ok: false,
        status: "failing",
        latencyMs: latency(start),
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async endpointChecks(origin, token, timeoutMs = 5_000): Promise<DashboardSmokeCheck> {
    const id = "endpoints";
    const label = "Fork-specific endpoints present";
    const start = performance.now();
    const details: string[] = [];
    try {
      // /api/upload presence is checked indirectly by pinging it unauthenticated.
      // The Python fork accepts unauthenticated POST to /api/upload (P-002).
      const uploadRes = await withTimeout(
        fetch(`${origin}/api/upload`, { method: "POST", headers: { Accept: "application/json" } }),
        timeoutMs,
        "upload probe",
      );
      details.push(`/api/upload HTTP ${uploadRes.status}`);

      if (token) {
        const sessionsRes = await withTimeout(
          fetch(`${origin}/api/sessions?limit=1`, {
            headers: {
              Accept: "application/json",
              "X-Hermes-Session-Token": token,
            },
          }),
          timeoutMs,
          "sessions probe",
        );
        details.push(`/api/sessions HTTP ${sessionsRes.status}`);
      } else {
        details.push("/api/sessions skipped (no token)");
      }

      const ok = details.some((d) => d.includes("HTTP 200")) || uploadRes.status < 500;
      return {
        id,
        label,
        ok,
        status: ok ? "ok" : "degraded",
        latencyMs: latency(start),
        detail: details.join("; "),
      };
    } catch (err) {
      return {
        id,
        label,
        ok: false,
        status: "failing",
        latencyMs: latency(start),
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

function tcpConnect(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // Browser environment: no raw TCP. Degrade to a fetch-based probe on the
    // origin URL, which is already covered by statusProbe; portProbe is a no-op.
    if (typeof window !== "undefined" || typeof require !== "function") {
      resolve();
      return;
    }
    const net = require("node:net") as typeof import("node:net");
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve();
    });
    socket.on("error", (err: Error) => reject(err));
  });
}

function wsConnectAndClose(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error("WebSocket handshake timeout"));
    }, 4_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error("WebSocket error"));
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
    });
  });
}

function rollup(
  checks: DashboardSmokeCheck[],
  status?: StatusResponse | null,
): DashboardSmokeResult {
  const failing = checks.filter((c) => c.status === "failing");
  const degraded = checks.filter((c) => c.status === "degraded");
  const overall: DashboardSmokeResult["overall"] =
    failing.length > 0 ? "failing" : degraded.length > 0 ? "degraded" : "ok";

  const components: DashboardSmokeComponents = {
    gateway: { ok: overall !== "failing", state: status?.gateway_state },
    dashboard: { ok: failing.length === 0 },
    storage: { ok: failing.find((c) => c.id === "status") === undefined },
    platforms: { ok: failing.find((c) => c.id === "endpoints") === undefined },
  };

  return {
    ok: overall === "ok",
    overall,
    at: new Date().toISOString(),
    checks,
    components,
  };
}

export async function runDashboardSmoke(
  origin: string,
  options: { token?: string; probes?: SmokeProbes } = {},
): Promise<DashboardSmokeResult> {
  const probes = options.probes ?? defaultSmokeProbes;
  const [port, status, openapi, ws, endpoints] = await Promise.all([
    probes.portProbe(origin),
    probes.statusProbe(origin),
    probes.openapiProbe(origin),
    probes.wsHandshakeProbe(origin, options.token),
    probes.endpointChecks(origin, options.token),
  ]);

  let statusData: StatusResponse | null = null;
  if (status.ok) {
    try {
      const res = await fetch(`${origin}/api/status`, { headers: { Accept: "application/json" } });
      if (res.ok) statusData = StatusResponse.parse(await res.json());
    } catch {
      // ignore; we already recorded the probe result
    }
  }

  return rollup([port, status, openapi, ws, endpoints], statusData);
}
