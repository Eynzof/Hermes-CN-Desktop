import type { DashboardAuthProvider, DashboardSessionStore } from "../auth";
import type { DashboardRequestContext, DashboardRouter } from "../router";

export interface AuthProviderInfo {
  name: string;
  displayName: string;
  supportsPassword: boolean;
  supportsToken: boolean;
}

export interface AuthRouteContext {
  providers: DashboardAuthProvider[];
  sessionStore: DashboardSessionStore;
}

function providerInfo(p: DashboardAuthProvider): AuthProviderInfo {
  return {
    name: p.name,
    displayName: p.displayName,
    supportsPassword: !!p.supportsPassword,
    supportsToken: !!p.supportsToken,
  };
}

function bodyField(body: unknown, key: string): string | undefined {
  if (typeof body === "object" && body !== null) {
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function unauthorized(message = "unauthorized"): { ok: false; error: string } {
  return { ok: false, error: message };
}

export function createAuthRoutes(
  router: DashboardRouter,
  ctx: AuthRouteContext,
): DashboardRouter {
  router.register("/api/auth/providers", () => ({
    providers: ctx.providers.map(providerInfo),
  }));

  router.register("/api/auth/me", async () => {
    // Managed local mode is single-user; this endpoint mirrors the Python
    // shape. A real gate would read the Authorization header from the context.
    return {
      ok: true,
      user: {
        sub: "desktop-local",
        name: "Desktop User",
      },
    };
  });

  router.register("/api/auth/password-login", async (req: DashboardRequestContext) => {
    const provider = ctx.providers.find((p) => p.supportsPassword && p.completePasswordLogin);
    if (!provider?.completePasswordLogin) {
      return { ok: false, error: "password login is not configured" };
    }
    const username = bodyField(req.body, "username") ?? "";
    const password = bodyField(req.body, "password") ?? "";
    const session = await provider.completePasswordLogin(username, password);
    if (!session) return unauthorized("invalid username or password");
    return { ok: true, session: { id: session.id, displayName: session.displayName } };
  }, "POST");

  router.register("/api/auth/token-login", async (req: DashboardRequestContext) => {
    const provider = ctx.providers.find((p) => p.supportsToken);
    const token = bodyField(req.body, "token") ?? "";
    if (!provider?.verifyToken) return { ok: false, error: "token login is not configured" };
    const principal = await provider.verifyToken(token);
    if (!principal) return unauthorized("invalid token");
    const session = await ctx.sessionStore.createSession({
      sub: principal.sub,
      displayName: principal.sub,
      scopes: principal.scopes ?? ["dashboard"],
    });
    return { ok: true, session: { id: session.id, displayName: session.displayName } };
  }, "POST");

  router.register("/api/auth/logout", async (req: DashboardRequestContext) => {
    const sessionId = bodyField(req.body, "session_id");
    if (sessionId) await ctx.sessionStore.revokeSession(sessionId);
    return { ok: true };
  }, "POST");

  router.register("/api/auth/refresh", async (req: DashboardRequestContext) => {
    const refreshToken = bodyField(req.body, "refresh_token");
    if (!refreshToken) return unauthorized("missing refresh token");
    for (const provider of ctx.providers) {
      if (provider.refreshSession) {
        const session = await provider.refreshSession(refreshToken);
        if (session) return { ok: true, session };
      }
    }
    return unauthorized("invalid refresh token");
  }, "POST");

  return router;
}
