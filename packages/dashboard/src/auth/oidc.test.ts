import { beforeEach, describe, expect, it, vi } from "vitest";
import { OidcAuthProvider } from "./oidc";
import { createInMemorySessionStore } from "./session-store";
import type { DashboardSessionStore } from "./provider";

interface Claims {
  sub: string;
  email?: string;
  name?: string;
  exp?: number;
}

function makeProvider(opts: {
  issuer?: string;
  clientId?: string;
  redirectUri?: string;
  displayName?: string;
  verifyIdToken?: (idToken: string) => Promise<Claims>;
  store?: DashboardSessionStore;
}) {
  const store = opts.store ?? createInMemorySessionStore({ secret: "s" });
  const verifyIdToken =
    opts.verifyIdToken ??
    vi.fn(async (idToken: string) => ({
      sub: idToken === "valid-token" ? "user-42" : "unknown",
      email: "user@example.com",
      name: "Example User",
    }));
  const provider = new OidcAuthProvider({
    displayName: opts.displayName ?? "Self-Hosted OIDC",
    issuer: opts.issuer ?? "https://sso.example.com/",
    clientId: opts.clientId ?? "desktop-client",
    redirectUri: opts.redirectUri ?? "hermes://callback",
    sessionStore: store,
    verifyIdToken,
  });
  return { provider, store, verifyIdToken };
}

describe("OidcAuthProvider", () => {
  it("exposes the provider contract metadata", () => {
    const { provider } = makeProvider({});
    expect(provider.name).toBe("oidc");
    expect(provider.displayName).toBe("Self-Hosted OIDC");
    expect("supportsPassword" in provider).toBe(false);
    expect("supportsToken" in provider).toBe(false);
  });

  it("startLogin builds a deterministic authorization URL", async () => {
    const { provider } = makeProvider({ issuer: "https://sso.example.com/" });
    const login = await provider.startLogin();
    const url = new URL(login.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://sso.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("id_token");
    expect(url.searchParams.get("client_id")).toBe("desktop-client");
    expect(url.searchParams.get("redirect_uri")).toBe("hermes://callback");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("oidc-state");
    expect(url.searchParams.get("nonce")).toBe("oidc-nonce");
    expect(login.state).toBe("oidc-state");
    expect(login.nonce).toBe("oidc-nonce");
  });

  it("startLogin is deterministic across calls", async () => {
    const { provider } = makeProvider({});
    const a = await provider.startLogin();
    const b = await provider.startLogin();
    expect(a).toEqual(b);
  });

  it("startLogin strips a single trailing slash from the issuer", async () => {
    const { provider } = makeProvider({ issuer: "https://sso.example.com/" });
    const login = await provider.startLogin();
    expect(new URL(login.authorizationUrl).pathname).toBe("/authorize");
  });

  it("startLogin keeps extra slashes when the issuer has more than one (as implemented)", async () => {
    // The implementation strips exactly one trailing slash.
    const { provider } = makeProvider({ issuer: "https://sso.example.com//" });
    const login = await provider.startLogin();
    expect(new URL(login.authorizationUrl).pathname).toBe("//authorize");
  });

  it("completeLogin verifies the id token and creates an OIDC session", async () => {
    const { provider, store, verifyIdToken } = makeProvider({});
    const session = await provider.completeLogin({ id_token: "valid-token", state: "oidc-state" });
    expect(verifyIdToken).toHaveBeenCalledWith("valid-token");
    expect(session.id).toBe("oidc:user-42");
    expect(session.displayName).toBe("Example User");
    expect(session.email).toBe("user@example.com");
    const principal = await store.verifyAccessToken(session.accessToken);
    expect(principal?.sub).toBe("oidc:user-42");
    expect(principal?.scopes).toEqual(["dashboard"]);
    const stored = await store.getSession("oidc:user-42");
    expect(stored).not.toBeNull();
  });

  it("completeLogin falls back to email then sub for display name", async () => {
    const verifyIdToken = vi.fn(async () => ({ sub: "u1", email: "u1@example.com" }));
    const { provider } = makeProvider({ verifyIdToken });
    const noName = await provider.completeLogin({ id_token: "t" });
    expect(noName.displayName).toBe("u1@example.com");

    const verifySubOnly = vi.fn(async () => ({ sub: "u2" }));
    const { provider: provider2 } = makeProvider({ verifyIdToken: verifySubOnly });
    const subOnly = await provider2.completeLogin({ id_token: "t" });
    expect(subOnly.displayName).toBe("u2");
  });

  it("completeLogin passes an empty string when id_token is missing", async () => {
    const verifyIdToken = vi.fn(async () => ({ sub: "u1" }));
    const { provider } = makeProvider({ verifyIdToken });
    await provider.completeLogin({});
    expect(verifyIdToken).toHaveBeenCalledWith("");
    await provider.completeLogin({ id_token: 42 });
    expect(verifyIdToken).toHaveBeenLastCalledWith("");
  });

  it("completeLogin propagates a failing verifyIdToken", async () => {
    const verifyIdToken = vi.fn(async () => {
      throw new Error("invalid signature");
    });
    const { provider } = makeProvider({ verifyIdToken });
    await expect(provider.completeLogin({ id_token: "bad" })).rejects.toThrow(
      "invalid signature",
    );
  });

  it("verifySession round-trips the created session", async () => {
    const { provider } = makeProvider({});
    const created = await provider.completeLogin({ id_token: "valid-token" });
    const verified = await provider.verifySession(created.accessToken);
    expect(verified?.id).toBe("oidc:user-42");
    expect(verified?.accessToken).toBe(created.accessToken);
  });

  it("verifySession returns null for revoked sessions", async () => {
    const { provider, store } = makeProvider({});
    const created = await provider.completeLogin({ id_token: "valid-token" });
    await store.revokeSession(created.id);
    expect(await provider.verifySession(created.accessToken)).toBeNull();
  });

  it("verifyToken delegates to the session store", async () => {
    const { provider } = makeProvider({});
    const created = await provider.completeLogin({ id_token: "valid-token" });
    const principal = await provider.verifyToken(created.accessToken);
    expect(principal?.sub).toBe("oidc:user-42");
    expect(await provider.verifyToken("bogus")).toBeNull();
  });

  it("does not implement password login or token login", async () => {
    const { provider } = makeProvider({});
    expect("completePasswordLogin" in provider).toBe(false);
    expect("refreshSession" in provider).toBe(false);
    // verifyToken exists (session-store-backed); startLogin/completeLogin exist.
    expect(provider.verifyToken).toBeDefined();
    expect(provider.startLogin).toBeDefined();
    expect(provider.completeLogin).toBeDefined();
  });
});

describe("OidcAuthProvider flow with an injected verifier", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("completes a full login → verify → logout cycle", async () => {
    const store = createInMemorySessionStore({ secret: "test-secret" });
    const { provider } = makeProvider({
      store,
      verifyIdToken: vi.fn(async () => ({ sub: "user-42", name: "Alice", exp: 1_800_000_000 })),
    });
    const login = await provider.startLogin();
    expect(login.authorizationUrl).toContain("client_id=desktop-client");

    const session = await provider.completeLogin({ id_token: "header.payload.sig" });
    expect(await provider.verifySession(session.accessToken)).not.toBeNull();

    await store.revokeSession(session.id);
    expect(await provider.verifySession(session.accessToken)).toBeNull();
  });
});
