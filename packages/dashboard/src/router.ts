/**
 * Local-first dashboard router.
 *
 * A tiny, testable request router that mirrors the FastAPI path registry.
 * It intentionally has no server or HTTP dependencies; handlers are pure
 * functions that return JSON.
 */

export interface DashboardRequestContext {
  path: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export type DashboardHandler<T = unknown> = (
  ctx: DashboardRequestContext,
) => Promise<T> | T;

interface RouteKey {
  path: string;
  method: string;
}

export class DashboardRouter {
  private exact = new Map<string, DashboardHandler>();
  private prefix: { key: string; handler: DashboardHandler }[] = [];

  private static key(route: RouteKey): string {
    return `${route.method.toUpperCase()} ${route.path}`;
  }

  /**
   * Register a handler for an exact path and method.
   * `method` defaults to "GET".
   */
  register(path: string, handler: DashboardHandler, method = "GET"): this {
    this.exact.set(DashboardRouter.key({ path, method }), handler);
    return this;
  }

  /**
   * Register a prefix handler. Chosen when no exact match exists and the
   * request path starts with the registered prefix.
   */
  registerPrefix(path: string, handler: DashboardHandler, method = "GET"): this {
    this.prefix.push({ key: DashboardRouter.key({ path, method }), handler });
    return this;
  }

  /**
   * Look up a handler for a request.
   */
  resolve(path: string, method = "GET"): DashboardHandler | undefined {
    const exact = this.exact.get(DashboardRouter.key({ path, method }));
    if (exact) return exact;

    const upperMethod = method.toUpperCase();
    for (const entry of this.prefix) {
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
   * Dispatch a request to a handler, or return a 404-shaped error.
   */
  async handle(ctx: DashboardRequestContext): Promise<unknown> {
    const handler = this.resolve(ctx.path, ctx.method);
    if (!handler) {
      return { ok: false, status: 404, error: `no handler for ${ctx.method} ${ctx.path}` };
    }
    return handler(ctx);
  }

  /** Remove an exact handler. */
  unregister(path: string, method = "GET"): this {
    this.exact.delete(DashboardRouter.key({ path, method }));
    return this;
  }

  /** Clear every registered handler. */
  clear(): this {
    this.exact.clear();
    this.prefix.length = 0;
    return this;
  }

  /** Snapshot of routes for debugging. */
  routes(): Array<{ path: string; method: string; kind: "exact" | "prefix" }> {
    const exact = Array.from(this.exact.keys()).map((k) => {
      const [method, ...pathParts] = k.split(" ");
      return { method, path: pathParts.join(" "), kind: "exact" as const };
    });
    const prefix = this.prefix.map((entry) => {
      const [method, ...pathParts] = entry.key.split(" ");
      return { method, path: pathParts.join(" "), kind: "prefix" as const };
    });
    return [...exact, ...prefix];
  }
}
