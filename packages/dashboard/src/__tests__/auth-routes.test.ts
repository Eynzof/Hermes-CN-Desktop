import { beforeEach, describe, expect, it } from "vitest";
import { BasicAuthProvider, TokenAuthProvider } from "../auth";
import { createInMemorySessionStore } from "../auth/session-store";
import { createAuthRoutes, type AuthRouteContext } from "../routes/auth";
import { DashboardRouter } from "../router";

describe("auth routes", () => {
  let store: ReturnType<typeof createInMemorySessionStore>;
  let router: DashboardRouter;

  beforeEach(() => {
    store = createInMemorySessionStore({ secret: "route-test" });
    const verifyPassword = async (p: string, h: string) => p === h;
    const basic = new BasicAuthProvider({
      users: { admin: "admin" },
      sessionStore: store,
      verifyPassword,
    });
    const token = new TokenAuthProvider({ secret: "hsk-", sessionStore: store });
    const ctx: AuthRouteContext = { providers: [basic, token], sessionStore: store };
    router = createAuthRoutes(new DashboardRouter(), ctx);
  });

  async function post(path: string, body: unknown) {
    return router.handle({ path, method: "POST", body, headers: {} });
  }

  it("lists providers", async () => {
    const result = await router.handle({
      path: "/api/auth/providers",
      method: "GET",
      body: null,
      headers: {},
    });
    expect(result).toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ name: "basic", supportsPassword: true }),
        expect.objectContaining({ name: "token", supportsToken: true }),
      ]),
    });
  });

  it("logs in with correct password", async () => {
    const result = await post("/api/auth/password-login", {
      username: "admin",
      password: "admin",
    });
    expect(result).toMatchObject({ ok: true, session: { displayName: "admin" } });
  });

  it("rejects wrong password", async () => {
    const result = await post("/api/auth/password-login", {
      username: "admin",
      password: "wrong",
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("logs in with a valid bearer token", async () => {
    const result = await post("/api/auth/token-login", { token: "hsk-local" });
    expect(result).toMatchObject({ ok: true, session: expect.any(Object) });
  });

  it("rejects an invalid bearer token", async () => {
    const result = await post("/api/auth/token-login", { token: "bad" });
    expect(result).toMatchObject({ ok: false });
  });

  it("logs out a session", async () => {
    const login = (await post("/api/auth/password-login", {
      username: "admin",
      password: "admin",
    })) as { ok: boolean; session: { id: string } };
    expect(login.ok).toBe(true);
    const logout = await post("/api/auth/logout", { session_id: login.session.id });
    expect(logout).toMatchObject({ ok: true });
  });
});
