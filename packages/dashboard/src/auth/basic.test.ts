import { describe, expect, it, vi } from "vitest";
import { BasicAuthProvider } from "./basic";
import { createInMemorySessionStore } from "./session-store";
import type { DashboardSessionStore } from "./provider";

/** Deterministic password verifier: plaintext must equal the stored hash. */
function makeVerifier() {
  const verifyPassword = (password: string, hash: string) => Promise.resolve(password === hash);
  const hashPassword = (password: string) => Promise.resolve(`hash:${password}`);
  return { verifyPassword, hashPassword };
}

describe("BasicAuthProvider", () => {
  it("exposes the provider contract metadata", () => {
    const { verifyPassword } = makeVerifier();
    const provider = new BasicAuthProvider({
      users: {},
      sessionStore: createInMemorySessionStore({ secret: "s" }),
      verifyPassword,
    });
    expect(provider.name).toBe("basic");
    expect(provider.displayName).toBe("用户名 / 密码");
    expect(provider.supportsPassword).toBe(true);
    expect("supportsToken" in provider).toBe(false);
  });

  it("logs in a valid user and creates a session", async () => {
    const { verifyPassword } = makeVerifier();
    const store = createInMemorySessionStore({ secret: "test-secret" });
    const provider = new BasicAuthProvider({
      users: { alice: "secret123" },
      sessionStore: store,
      verifyPassword,
    });
    const session = await provider.completePasswordLogin("alice", "secret123");
    expect(session).not.toBeNull();
    expect(session?.displayName).toBe("alice");
    expect(session?.accessToken).toContain(".");
    expect(session?.id).toBe("basic:alice");
    // The session's principal is only visible through the store token check.
    const principal = await store.verifyAccessToken(session!.accessToken);
    expect(principal?.sub).toBe("basic:alice");
    expect(principal?.scopes).toEqual(["dashboard"]);
  });

  it("rejects a wrong password without creating a session", async () => {
    const { verifyPassword } = makeVerifier();
    const store = createInMemorySessionStore({ secret: "test-secret" });
    const provider = new BasicAuthProvider({
      users: { alice: "secret123" },
      sessionStore: store,
      verifyPassword,
    });
    expect(await provider.completePasswordLogin("alice", "wrong")).toBeNull();
    expect(await store.getSession("basic:alice")).toBeNull();
  });

  it("rejects unknown users without invoking the verifier", async () => {
    let verifierCalls = 0;
    const verifyPassword = async () => {
      verifierCalls += 1;
      return true;
    };
    const provider = new BasicAuthProvider({
      users: { alice: "secret123" },
      sessionStore: createInMemorySessionStore({ secret: "s" }),
      verifyPassword,
    });
    expect(await provider.completePasswordLogin("bob", "whatever")).toBeNull();
    expect(verifierCalls).toBe(0);
  });

  it("supports multiple users and distinct sessions", async () => {
    const { verifyPassword } = makeVerifier();
    const provider = new BasicAuthProvider({
      users: { alice: "a", bob: "b" },
      sessionStore: createInMemorySessionStore({ secret: "s" }),
      verifyPassword,
    });
    const alice = await provider.completePasswordLogin("alice", "a");
    const bob = await provider.completePasswordLogin("bob", "b");
    expect(alice?.id).toBe("basic:alice");
    expect(bob?.id).toBe("basic:bob");
  });

  it("hashPassword is optional and never used during login", async () => {
    const { verifyPassword, hashPassword } = makeVerifier();
    const hashSpy = vi.fn(hashPassword);
    const provider = new BasicAuthProvider({
      users: { alice: "secret123" },
      sessionStore: createInMemorySessionStore({ secret: "s" }),
      verifyPassword,
      hashPassword: hashSpy,
    });
    await provider.completePasswordLogin("alice", "secret123");
    expect(hashSpy).not.toHaveBeenCalled();
  });

  it("verifySession round-trips the created session with its access token", async () => {
    const { verifyPassword } = makeVerifier();
    const provider = new BasicAuthProvider({
      users: { alice: "secret123" },
      sessionStore: createInMemorySessionStore({ secret: "test-secret" }),
      verifyPassword,
    });
    const created = await provider.completePasswordLogin("alice", "secret123");
    const verified = await provider.verifySession(created!.accessToken);
    expect(verified).not.toBeNull();
    expect(verified?.id).toBe("basic:alice");
    expect(verified?.accessToken).toBe(created!.accessToken);
  });

  it("verifySession returns null for a revoked session", async () => {
    const { verifyPassword } = makeVerifier();
    const store = createInMemorySessionStore({ secret: "test-secret" });
    const provider = new BasicAuthProvider({
      users: { alice: "secret123" },
      sessionStore: store,
      verifyPassword,
    });
    const created = await provider.completePasswordLogin("alice", "secret123");
    await store.revokeSession(created!.id);
    expect(await provider.verifySession(created!.accessToken)).toBeNull();
  });

  it("verifySession returns null for an unknown session id", async () => {
    const { verifyPassword } = makeVerifier();
    const store = createInMemorySessionStore({ secret: "test-secret" });
    const provider = new BasicAuthProvider({
      users: { alice: "secret123" },
      sessionStore: store,
      verifyPassword,
    });
    const created = await provider.completePasswordLogin("alice", "secret123");
    // Token for a session that exists but belongs to another store secret.
    const otherStore = createInMemorySessionStore({ secret: "other-secret" });
    const foreign = await otherStore.createSession({ sub: "basic:alice" });
    void created;
    expect(await provider.verifySession(foreign.accessToken)).toBeNull();
  });

  it("verifyToken delegates to the session store", async () => {
    const { verifyPassword } = makeVerifier();
    const store = createInMemorySessionStore({ secret: "test-secret" });
    const provider = new BasicAuthProvider({
      users: { alice: "secret123" },
      sessionStore: store,
      verifyPassword,
    });
    const created = await provider.completePasswordLogin("alice", "secret123");
    const principal = await provider.verifyToken(created!.accessToken);
    expect(principal?.sub).toBe("basic:alice");
    expect(principal?.scopes).toEqual(["dashboard"]);
    expect(await provider.verifyToken("garbage")).toBeNull();
  });

  it("works with a real hashing verifier shape (password vs hash)", async () => {
    // Simulate a caller that stores a digest: hash = sha256(password).
    const store: DashboardSessionStore = createInMemorySessionStore({ secret: "s" });
    const verifyPassword = async (password: string, hash: string) => {
      const { digestSha256 } = await import("./crypto");
      return (await digestSha256(password)) === hash;
    };
    const { digestSha256 } = await import("./crypto");
    const provider = new BasicAuthProvider({
      users: { alice: await digestSha256("correct horse") },
      sessionStore: store,
      verifyPassword,
    });
    expect(await provider.completePasswordLogin("alice", "correct horse")).not.toBeNull();
    expect(await provider.completePasswordLogin("alice", "wrong")).toBeNull();
  });
});
