import { describe, expect, it } from "vitest";
import { TokenAuthProvider } from "./token";
import { createInMemorySessionStore } from "./session-store";
import type { TokenPrincipal } from "./provider";

describe("TokenAuthProvider", () => {
  it("exposes the provider contract metadata", () => {
    const provider = new TokenAuthProvider({
      secret: "hsk-",
      sessionStore: createInMemorySessionStore({ secret: "s" }),
    });
    expect(provider.name).toBe("token");
    expect(provider.displayName).toBe("访问令牌");
    expect(provider.supportsToken).toBe(true);
    expect("supportsPassword" in provider).toBe(false);
  });

  it("accepts tokens with the configured prefix via the default extractor", async () => {
    const provider = new TokenAuthProvider({
      secret: "hsk-",
      sessionStore: createInMemorySessionStore({ secret: "s" }),
    });
    const principal = await provider.verifyToken("hsk-local");
    expect(principal).toEqual({ sub: "service" });
  });

  it("rejects tokens without the configured prefix", async () => {
    const provider = new TokenAuthProvider({
      secret: "hsk-",
      sessionStore: createInMemorySessionStore({ secret: "s" }),
    });
    expect(await provider.verifyToken("other")).toBeNull();
    expect(await provider.verifyToken("")).toBeNull();
  });

  it("rejects a prefix that is only partial", async () => {
    const provider = new TokenAuthProvider({
      secret: "hsk-",
      sessionStore: createInMemorySessionStore({ secret: "s" }),
    });
    // "hsk" is a prefix of the token but not of the secret requirement.
    expect(await provider.verifyToken("hsk")).toBeNull();
  });

  it("uses a custom principal extractor when provided", async () => {
    const extractPrincipal = (token: string): TokenPrincipal | null =>
      token === "special" ? { sub: "admin", scopes: ["dashboard", "admin"] } : null;
    const provider = new TokenAuthProvider({
      secret: "hsk-",
      sessionStore: createInMemorySessionStore({ secret: "s" }),
      extractPrincipal,
    });
    expect(await provider.verifyToken("special")).toEqual({
      sub: "admin",
      scopes: ["dashboard", "admin"],
    });
    expect(await provider.verifyToken("anything-else")).toBeNull();
  });

  it("verifySession resolves the principal to a stored session", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const provider = new TokenAuthProvider({ secret: "hsk-", sessionStore: store });
    const session = await store.createSession({
      sub: "service",
      displayName: "Service Account",
      scopes: ["dashboard"],
    });
    const verified = await provider.verifySession("hsk-whatever");
    expect(verified).not.toBeNull();
    expect(verified?.id).toBe(session.id);
    expect(verified?.displayName).toBe("Service Account");
    expect(verified?.accessToken).toBe("hsk-whatever");
  });

  it("verifySession returns null when no session exists for the principal", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const provider = new TokenAuthProvider({ secret: "hsk-", sessionStore: store });
    expect(await provider.verifySession("hsk-no-session")).toBeNull();
  });

  it("verifySession returns null for a revoked session", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const provider = new TokenAuthProvider({ secret: "hsk-", sessionStore: store });
    const session = await store.createSession({ sub: "service" });
    await store.revokeSession(session.id);
    expect(await provider.verifySession("hsk-anything")).toBeNull();
  });

  it("verifySession returns null when the token itself is invalid", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    await store.createSession({ sub: "service" });
    const provider = new TokenAuthProvider({ secret: "hsk-", sessionStore: store });
    expect(await provider.verifySession("wrong-prefix")).toBeNull();
  });

  it("does not implement a password login flow", async () => {
    const provider = new TokenAuthProvider({
      secret: "hsk-",
      sessionStore: createInMemorySessionStore({ secret: "s" }),
    });
    expect("completePasswordLogin" in provider).toBe(false);
    expect("startLogin" in provider).toBe(false);
    expect("refreshSession" in provider).toBe(false);
  });
});
