import { describe, expect, it, vi } from "vitest";
import type {
  CreateSessionInput,
  DashboardAuthProvider,
  DashboardSessionStore,
  LoginStart,
  Session,
  TokenPrincipal,
} from "./provider";
import { createInMemorySessionStore } from "./session-store";

/**
 * Provider abstraction contract tests. `provider.ts` is an interface module;
 * these tests lock the shape of the contract so implementations (basic, token,
 * oidc) cannot silently drift from the consumers (routes/auth.ts).
 */
describe("provider contract", () => {
  it("LoginStart carries authorizationUrl, state and optional nonce", () => {
    const start: LoginStart = {
      authorizationUrl: "https://idp.example.com/authorize?x=1",
      state: "abc",
      nonce: "def",
    };
    expect(start.authorizationUrl).toContain("authorize");
    expect(start.state).toBe("abc");
    expect(start.nonce).toBe("def");
  });

  it("Session shape carries id, accessToken and optional metadata", () => {
    const session: Session = {
      id: "s1",
      displayName: "Alice",
      email: "alice@example.com",
      accessToken: "s1.sig",
      refreshToken: "rt",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    };
    expect(session.id).toBe("s1");
    expect(session.accessToken).toContain(".");
  });

  it("TokenPrincipal carries sub and optional scopes", () => {
    const principal: TokenPrincipal = { sub: "user-1", scopes: ["dashboard"] };
    expect(principal.sub).toBe("user-1");
    expect(principal.scopes).toContain("dashboard");
  });

  it("CreateSessionInput defaults sub to the session id when absent", async () => {
    const store: DashboardSessionStore = createInMemorySessionStore({ secret: "s" });
    const input: CreateSessionInput = { displayName: "Only Name" };
    const session = await store.createSession(input);
    expect(session.id).toBeTruthy();
    const principal = await store.verifyAccessToken(session.accessToken);
    expect(principal?.sub).toBe(session.id);
  });

  it("a provider with all optional capabilities satisfies the contract", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const capabilities = {
      startLogin: vi.fn(async (): Promise<LoginStart> => ({
        authorizationUrl: "https://idp/authorize",
        state: "st",
      })),
      completeLogin: vi.fn(async (): Promise<Session> =>
        store.createSession({ sub: "oauth:u" }),
      ),
      refreshSession: vi.fn(async (): Promise<Session | null> =>
        store.createSession({ sub: "oauth:u" }),
      ),
      completePasswordLogin: vi.fn(async (): Promise<Session | null> =>
        store.createSession({ sub: "basic:u" }),
      ),
      verifyToken: vi.fn(async (): Promise<TokenPrincipal | null> => ({ sub: "svc" })),
    };

    const provider: DashboardAuthProvider = {
      name: "full",
      displayName: "Full Provider",
      supportsPassword: true,
      supportsToken: true,
      verifySession: async (accessToken: string): Promise<Session | null> => {
        const principal = await store.verifyAccessToken(accessToken);
        if (!principal) return null;
        const session = await store.getSession(principal.sub);
        return session ? { ...session, accessToken } : null;
      },
      ...capabilities,
    };

    expect(provider.name).toBe("full");
    expect(provider.verifySession).toBeDefined();
    // Optional capability dispatch used by routes/auth.ts:
    const login = await provider.completePasswordLogin?.("u", "p");
    expect(login).not.toBeNull();
    const start = await provider.startLogin?.({});
    expect(start?.state).toBe("st");
    const principal = await provider.verifyToken?.("tok");
    expect(principal?.sub).toBe("svc");
    const refreshed = await provider.refreshSession?.("rt");
    expect(refreshed).not.toBeNull();
    expect(capabilities.completePasswordLogin).toHaveBeenCalledWith("u", "p");
    expect(capabilities.startLogin).toHaveBeenCalledWith({});
  });

  it("a minimal provider (verifySession only) is still contract-valid", async () => {
    const provider: DashboardAuthProvider = {
      name: "minimal",
      displayName: "Minimal",
      verifySession: async () => null,
    };
    expect(provider.supportsPassword).toBeUndefined();
    expect(provider.supportsToken).toBeUndefined();
    expect(provider.startLogin).toBeUndefined();
    expect(await provider.verifySession("t")).toBeNull();
  });
});
