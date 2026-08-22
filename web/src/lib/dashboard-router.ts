/**
 * Local-first dashboard route registry.
 *
 * Implements the in-process REST layer described in `plans/web-dashboard.md`.
 * Handlers are registered per path/method and take precedence over the remote
 * `api_request` proxy when the desktop is in managed mode. Unregistered paths
 * fall back to the existing transport so migration can happen route-by-route.
 */

export interface DashboardRequestContext {
  path: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export type DashboardHandler<T = unknown> = (ctx: DashboardRequestContext) => Promise<T> | T;

interface RouteKey {
  path: string;
  method: string;
}

const registry = new Map<string, DashboardHandler>();
const prefixRegistry: { key: string; handler: DashboardHandler }[] = [];

function key(route: RouteKey): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

/**
 * Register a local-first dashboard handler.
 * `method` defaults to "GET". Overwrites any existing registration.
 */
export function registerDashboardHandler(
  path: string,
  handler: DashboardHandler,
  method = "GET",
): void {
  registry.set(key({ path, method }), handler);
}

/**
 * Register a prefix handler. The handler is chosen when no exact match exists
 * and the request path starts with the registered prefix.
 */
export function registerDashboardPrefixHandler(
  path: string,
  handler: DashboardHandler,
  method = "GET",
): void {
  prefixRegistry.push({ key: key({ path, method }), handler });
}

/**
 * Remove a registered handler.
 */
export function unregisterDashboardHandler(path: string, method = "GET"): void {
  registry.delete(key({ path, method }));
}

/**
 * Look up a handler for a request. Path matching is exact for now;
 * path parameters can be handled inside the handler.
 */
export function getDashboardHandler(
  path: string,
  method = "GET",
): DashboardHandler | undefined {
  const exact = registry.get(key({ path, method }));
  if (exact) return exact;
  const upperMethod = method.toUpperCase();
  for (const entry of prefixRegistry) {
    const [entryMethod, ...pathParts] = entry.key.split(" ");
    const entryPath = pathParts.join(" ");
    if (
      entryMethod === upperMethod &&
      (path === entryPath || path.startsWith(`${entryPath}/`))
    ) {
      return entry.handler;
    }
  }
  return undefined;
}

/**
 * Register several handlers at once. Useful for feature modules that port a
 * family of routes (e.g. `/api/cron/*`).
 */
export function createDashboardRouter(routes: Record<string, DashboardHandler>): void {
  for (const [pathWithMethod, handler] of Object.entries(routes)) {
    const [method, path] = pathWithMethod.includes(" ")
      ? pathWithMethod.split(" ", 2)
      : ["GET", pathWithMethod];
    registerDashboardHandler(path, handler, method);
  }
}

/**
 * Clear every registered handler. Intended for tests and hot-reload dev.
 */
export function clearDashboardRegistry(): void {
  registry.clear();
  prefixRegistry.length = 0;
}

/**
 * Snapshot of the current registry for debugging.
 */
export function listDashboardRoutes(): Array<{ path: string; method: string; kind: "exact" | "prefix" }> {
  const exact = Array.from(registry.keys()).map((k) => {
    const [method, ...pathParts] = k.split(" ");
    return { method, path: pathParts.join(" "), kind: "exact" as const };
  });
  const prefix = prefixRegistry.map((entry) => {
    const [method, ...pathParts] = entry.key.split(" ");
    return { method, path: pathParts.join(" "), kind: "prefix" as const };
  });
  return [...exact, ...prefix];
}
