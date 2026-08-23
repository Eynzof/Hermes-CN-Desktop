import { describe, expect, it, vi } from "vitest";
import { createAuthRoutes } from "./auth";
import type { AuthRouteContext } from "./auth";
import { DashboardRouter } from "../router";
import { BasicAuthProvider } from "../auth/basic";
import { TokenAuthProvider } from "../auth/token";
import { createInMemorySessionStore } from "../auth/session-store";
import type { DashboardAuthProvider } from "../auth/provider";

function buildContext(providers: DashboardAuthProvider[]): AuthRouteContext {
  return {
    providers,
    sessionStore: createInMemorySessionStore({ secret: "test-secret" }),
  };
}

async function post(router: DashboardRouter, path: string, body: unknown) {
  return router.handle({ path, method: "POST", body, headers: {} });
}

async function get(router: DashboardRouter, path: string) {
  return router.handle({ path, method: "GET", body: null, headers: {} });
}

function basicProviders(): DashboardAuthProvider[] {
  const store = createInMemorySessionStore({ secret: "test-secret" });
  const basic = new BasicAuthProvider({
    users: { admin: "admin-hash" },
    sessionStore: store,
    verifyPassword: async (p, h) => p === h,
  });
  const token = new TokenAuthProvider({ secret: "hsk-", sessionStore: store });
  return [basic, token];
}

/**
 * Co-located deep coverage for the auth routes. The pre-existing
 * `src/__tests__/auth-routes.test.ts` covers the happy paths; this suite adds
 * configuration-failure, refresh, and malformed-input cases.
 */
describe("createAuthRoutes", () => {
  it("GET /api/auth/providers lists provider capabilities", async () => {
    const router = createAuthRoutes(new DashboardRouter(), buildContext(basicProviders()));
    const result = (await get(router, "/api/auth/providers")) as {
      providers: Array<{ name: string; supportsPassword: boolean; supportsToken: boolean }>;
    };
    const byName = new Map(result.providers.map((p) => [p.name, p]));
    expect(byName.get("basic")).toMatchObject({ supportsPassword: true, supportsToken: false });
    expect(byName.get("token")).toMatchObject({ supportsPassword: false, supportsToken: true });
  });

  it("GET /api/auth/me returns the local desktop user", async () => {
    const router = createAuthRoutes(new DashboardRouter(), buildContext(basicProviders()));
    await expect(get(router, "/api/auth/me")).resolves.toMatchObject({
      ok: true,
      user: { sub: "desktop-local", name: "Desktop User" },
    });
  });

  it("POST /api/auth/password-login succeeds with correct credentials", async () => {
    const router = createAuthRoutes(new DashboardRouter(), buildContext(basicProviders()));
    const result = (await post(router, "/api/auth/password-login", {
      username: "admin",
      password: "admin-hash",
    })) as { ok: boolean; session: { id: string; displayName: string } };
    expect(result.ok).toBe(true);
    expect(result.session.displayName).toBe("admin");
    expect(result.session.id).toBe("basic:admin");
  });

  it("POST /api/auth/password-login rejects wrong credentials", async () => {
    const router = createAuthRoutes(new DashboardRouter(), buildContext(basicProviders()));
    await expect(
      post(router, "/api/auth/password-login", { username: "admin", password: "wrong" }),
    ).resolves.toEqual({ ok: false, error: "invalid username or password" });
  });

  it("POST /api/auth/password-login rejects missing or non-string fields", async () => {
    const router = createAuthRoutes(new DashboardRouter(), buildContext(basicProviders()));
    await expect(
      post(router, "/api/auth/password-login", { username: "admin" }),
    ).resolves.toEqual({ ok: false, error: "invalid username or password" });
    await expect(
      post(router, "/api/auth/password-login", { username: 42, password: 42 }),
    ).resolves.toEqual({ ok: false, error: "invalid username or password" });
    await expect(
      post(router, "/api/auth/password-login", null),
    ).resolves.toEqual({ ok: false, error: "invalid username or password" });
  });

  it("POST /api/auth/password-login fails when no password provider is configured", async () => {
    const router = createAuthRoutes(new DashboardRouter(), buildContext([]));
    await expect(
      post(router, "/api/auth/password-login", { username: "admin", password: "x" }),
    ).resolves.toEqual({ ok: false, error: "password login is not configured" });
  });

  it("POST /api/auth/token-login succeeds with a valid token", async () => {
    const router = createAuthRoutes(new DashboardRouter(), buildContext(basicProviders()));
    const result = (await post(router, "/api/auth/token-login", {
      token: "hsk-local",
    })) as { ok: boolean; session: { id: string; displayName: string } };
    expect(result.ok).toBe(true);
    expect(result.session.id).toBe("service");
    expect(result.session.displayName).toBe("service");
  });

  it("POST /api/auth/token-login rejects invalid tokens", async () => {
    const router = createAuthRoutes(new DashboardRouter(), buildContext(basicProviders()));
    await expect(post(router, "/api/auth/token-login", { token: "bad" })).resolves.toEqual({
      ok: false,
      error: "invalid token",
    });
    await expect(post(router, "/api/auth/token-login", {})).resolves.toEqual({
      ok: false,
      error: "invalid token",
    });
  });

  it("POST /api/auth/token-login fails when no token provider is configured", async () => {
    const router = createAuthRoutes(new DashboardRouter(), buildContext([]));
    await expect(post(router, "/api/auth/token-login", { token: "hsk-x" })).resolves.toEqual({
      ok: false,
      error: "token login is not configured",
    });
  });

  it("POST /api/auth/logout revokes the session and returns ok", async () => {
    const ctx = buildContext(basicProviders());
    const router = createAuthRoutes(new DashboardRouter(), ctx);
    const login = (await post(router, "/api/auth/password-login", {
      username: "admin",
      password: "admin-hash",
    })) as { ok: boolean; session: { id: string } };
    await expect(post(router, "/api/auth/logout", { session_id: login.session.id })).resolves.toEqual(
      { ok: true },
    );
    // The revoked session can no longer be verified.
    const stored = await ctx.sessionStore.getSession(login.session.id);
    expect(stored).toBeNull();
  });

  it("POST /api/auth/logout without a session id still returns ok", async () => {
    const router = createAuthRoutes(new DashboardRouter(), buildContext(basicProviders()));
    await expect(post(router, "/api/auth/logout", {})).resolves.toEqual({ ok: true });
    await expect(post(router, "/api/auth/logout", null)).resolves.toEqual({ ok: true });
  });

  it("POST /api/auth/refresh succeeds via a provider refreshSession", async () => {
    const refreshSession = vi.fn(async (refreshToken: string) =>
      refreshToken === "rt-good"
        ? { id: "refreshed", sub: "user", displayName: "U", accessToken: "new-token" }
        : null,
    );
    const provider: DashboardAuthProvider = {
      name: "refreshable",
      displayName: "Refreshable",
      supportsToken: true,
      verifySession: async () => null,
      refreshSession,
    };
    const router = createAuthRoutes(new DashboardRouter(), buildContext([provider]));
    await expect(post(router, "/api/auth/refresh", { refresh_token: "rt-good" })).resolves.toEqual({
      ok: true,
      session: { id: "refreshed", sub: "user", displayName: "U", accessToken: "new-token" },
    });
    expect(refreshSession).toHaveBeenCalledWith("rt-good");
  });

  it("POST /api/auth/refresh rejects unknown refresh tokens", async () => {
    const router = createAuthRoutes(new DashboardRouter(), buildContext(basicProviders()));
    await expect(post(router, "/api/auth/refresh", { refresh_token: "rt-bad" })).resolves.toEqual({
      ok: false,
      error: "invalid refresh token",
    });
  });

  it("POST /api/auth/refresh requires a refresh token field", async () => {
    const router = createAuthRoutes(new DashboardRouter(), buildContext(basicProviders()));
    await expect(post(router, "/api/auth/refresh", {})).resolves.toEqual({
      ok: false,
      error: "missing refresh token",
    });
  });

  it("POST /api/auth/refresh fails when no provider refreshes", async () => {
    const provider: DashboardAuthProvider = {
      name: "no-refresh",
      displayName: "No Refresh",
      verifySession: async () => null,
    };
    const router = createAuthRoutes(new DashboardRouter(), buildContext([provider]));
    await expect(post(router, "/api/auth/refresh", { refresh_token: "rt" })).resolves.toEqual({
      ok: false,
      error: "invalid refresh token",
    });
  });

  it("uses the first provider that can handle a password login", async () => {
    const called: string[] = [];
    const first: DashboardAuthProvider = {
      name: "first",
      displayName: "First",
      supportsPassword: true,
      verifySession: async () => null,
      completePasswordLogin: async () => {
        called.push("first");
        return { id: "first-session", accessToken: "a" };
      },
    };
    const second: DashboardAuthProvider = {
      name: "second",
      displayName: "Second",
      supportsPassword: true,
      verifySession: async () => null,
      completePasswordLogin: async () => {
        called.push("second");
        return { id: "second-session", accessToken: "b" };
      },
    };
    const router = createAuthRoutes(new DashboardRouter(), buildContext([first, second]));
    const result = (await post(router, "/api/auth/password-login", {
      username: "u",
      password: "p",
    })) as { session: { id: string } };
    expect(result.session.id).toBe("first-session");
    expect(called).toEqual(["first"]);
  });
});
