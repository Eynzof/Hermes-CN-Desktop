/**
 * Local-first dashboard route registry.
 *
 * Implements the local-first REST layer (see docs/typescript-runtime.md).
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

// Separate registry for browser-only (run.py) fallback handlers. These are
// only consulted when the desktop is NOT in managed mode — i.e. running as a
// standalone web app with no Tauri shell and no attached Python dashboard
// (see runtime.isLocalOnly()). The in-process TS agent is the sole runtime in
// that mode, so routes the managed-mode backend would have served (profiles,
// model/info, analytics, skills, logs) must resolve locally to avoid the Vite
// proxy forwarding them to a dead 127.0.0.1:9120 and producing ECONNREFUSED.
// Managed/attached mode ignores this registry entirely — the real backend
// serves those endpoints there.
const localOnlyRegistry = new Map<string, DashboardHandler>();
const localOnlyPrefixRegistry: { key: string; handler: DashboardHandler }[] = [];

function key(route: RouteKey): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

/**
 * Strip the query string for route matching. Callers pass the full request
 * path (e.g. `/api/logs?file=errors&lines=50`) but routes are registered by
 * pathname only (`/api/logs`). Without this, exact and prefix lookups miss
 * every request that carries a query string.
 */
function stripQuery(path: string): string {
  const q = path.indexOf("?");
  return q >= 0 ? path.slice(0, q) : path;
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

function lookupHandler(
  path: string,
  method = "GET",
  exactMap: Map<string, DashboardHandler>,
  prefixList: { key: string; handler: DashboardHandler }[],
): DashboardHandler | undefined {
  const pathname = stripQuery(path);
  const exact = exactMap.get(key({ path: pathname, method }));
  if (exact) return exact;
  const upperMethod = method.toUpperCase();
  for (const entry of prefixList) {
    const [entryMethod, ...pathParts] = entry.key.split(" ");
    const entryPath = pathParts.join(" ");
    // If the prefix ends with "/" (e.g. "/api/profiles/"), don't append
    // another "/" — that would produce "/api/profiles//" and never match.
    const boundary = entryPath.endsWith("/") ? entryPath : `${entryPath}/`;
    if (
      entryMethod === upperMethod &&
      (pathname === entryPath || pathname.startsWith(boundary))
    ) {
      return entry.handler;
    }
  }
  return undefined;
}

/**
 * Look up a handler for a request. Path matching is exact for now;
 * path parameters can be handled inside the handler. The query string is
 * stripped before matching so `/api/logs?file=errors` resolves to the
 * registered `/api/logs` route.
 */
export function getDashboardHandler(
  path: string,
  method = "GET",
): DashboardHandler | undefined {
  return lookupHandler(path, method, registry, prefixRegistry);
}

/**
 * Look up a browser-only (run.py) fallback handler. Only consulted when the
 * desktop is in standalone web mode (no Tauri shell, no Python backend).
 * Managed and attached modes ignore this registry and let the real backend
 * serve the request.
 */
export function getLocalOnlyDashboardHandler(
  path: string,
  method = "GET",
): DashboardHandler | undefined {
  return lookupHandler(path, method, localOnlyRegistry, localOnlyPrefixRegistry);
}

/**
 * Register a browser-only (run.py) fallback handler. `method` defaults to
 * "GET". Overwrites any existing registration. These handlers are only
 * consulted when `runtime.isLocalOnly()` is true.
 */
export function registerLocalOnlyHandler(
  path: string,
  handler: DashboardHandler,
  method = "GET",
): void {
  localOnlyRegistry.set(key({ path, method }), handler);
}

/**
 * Register a browser-only prefix handler. Only consulted in standalone web
 * mode.
 */
export function registerLocalOnlyPrefixHandler(
  path: string,
  handler: DashboardHandler,
  method = "GET",
): void {
  localOnlyPrefixRegistry.push({ key: key({ path, method }), handler });
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
  localOnlyRegistry.clear();
  localOnlyPrefixRegistry.length = 0;
}

/**
 * Snapshot of the current registry for debugging.
 */
export function listDashboardRoutes(): Array<{ path: string; method: string; kind: "exact" | "prefix" | "local-only" | "local-only-prefix" }> {
  const exact = Array.from(registry.keys()).map((k) => {
    const [method, ...pathParts] = k.split(" ");
    return { method, path: pathParts.join(" "), kind: "exact" as const };
  });
  const prefix = prefixRegistry.map((entry) => {
    const [method, ...pathParts] = entry.key.split(" ");
    return { method, path: pathParts.join(" "), kind: "prefix" as const };
  });
  const localExact = Array.from(localOnlyRegistry.keys()).map((k) => {
    const [method, ...pathParts] = k.split(" ");
    return { method, path: pathParts.join(" "), kind: "local-only" as const };
  });
  const localPrefix = localOnlyPrefixRegistry.map((entry) => {
    const [method, ...pathParts] = entry.key.split(" ");
    return { method, path: pathParts.join(" "), kind: "local-only-prefix" as const };
  });
  return [...exact, ...prefix, ...localExact, ...localPrefix];
}
