import { describe, expect, it } from "vitest";
import { BasicAuthProvider, TokenAuthProvider } from "../auth";
import { createInMemorySessionStore } from "../auth/session-store";

describe("BasicAuthProvider", () => {
  async function makeProvider(users: Record<string, string>) {
    const store = createInMemorySessionStore({ secret: "test-secret" });
    const verifyPassword = async (password: string, hash: string) => password === hash;
    return new BasicAuthProvider({ users, sessionStore: store, verifyPassword });
  }

  it("logs in valid users", async () => {
    const provider = await makeProvider({ alice: "secret123" });
    const session = await provider.completePasswordLogin!("alice", "secret123");
    expect(session).not.toBeNull();
    expect(session?.displayName).toBe("alice");
  });

  it("rejects bad passwords", async () => {
    const provider = await makeProvider({ alice: "secret123" });
    const session = await provider.completePasswordLogin!("alice", "wrong");
    expect(session).toBeNull();
  });

  it("rejects unknown users", async () => {
    const provider = await makeProvider({ alice: "secret123" });
    const session = await provider.completePasswordLogin!("bob", "secret123");
    expect(session).toBeNull();
  });

  it("verifies its own session token", async () => {
    const provider = await makeProvider({ alice: "secret123" });
    const session = await provider.completePasswordLogin!("alice", "secret123");
    expect(session).not.toBeNull();
    const verified = await provider.verifySession(session!.accessToken);
    expect(verified?.id).toBe(session!.id);
  });
});

describe("TokenAuthProvider", () => {
  it("validates bearer tokens with the configured secret", async () => {
    const store = createInMemorySessionStore({ secret: "x" });
    const provider = new TokenAuthProvider({ secret: "hsk-", sessionStore: store });
    const principal = await provider.verifyToken!("hsk-local");
    expect(principal?.sub).toBe("service");
  });

  it("rejects tokens that do not match the secret", async () => {
    const store = createInMemorySessionStore({ secret: "x" });
    const provider = new TokenAuthProvider({ secret: "hsk-", sessionStore: store });
    expect(await provider.verifyToken!("other")).toBeNull();
  });
});
