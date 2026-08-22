import type { DashboardRouter } from "../router";

export interface DashboardStatus {
  ok: boolean;
  platform: string;
  version: string;
  connection_mode: "managed" | "local" | "remote";
}

export function createStatusRoutes(
  router: DashboardRouter,
  opts: { version: string; connectionMode?: DashboardStatus["connection_mode"] } = {
    version: "0.0.0",
    connectionMode: "managed",
  },
): DashboardRouter {
  router.register("/api/status", (): DashboardStatus => ({
    ok: true,
    platform: "desktop",
    version: opts.version,
    connection_mode: opts.connectionMode ?? "managed",
  }));

  router.register("/api/health", () => ({ ok: true }));

  router.register("/api/version", () => ({
    version: opts.version,
    platform: "desktop",
  }));

  return router;
}
