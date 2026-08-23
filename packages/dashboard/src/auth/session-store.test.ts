import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemorySessionStore } from "./session-store";
import { hmac } from "./crypto";

/**
 * Co-located deep coverage for the in-memory session store. The pre-existing
 * `src/__tests__/session-store.test.ts` covers the happy path; this suite adds
 * deterministic-token, expiry, and edge-case coverage.
 */
describe("createInMemorySessionStore", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("signs access tokens deterministically with a fixed secret", async () => {
    const store = createInMemorySessionStore({ secret: "test-secret" });
    const session = await store.createSession({ sub: "user-1" });
    expect(session.id).toBe("user-1");
    expect(session.accessToken).toBe(`user-1.${await hmac("user-1", "test-secret")}`);
    // Same id in a store with the same secret signs identically.
    const store2 = createInMemorySessionStore({ secret: "test-secret" });
    const session2 = await store2.createSession({ sub: "user-1" });
    expect(session2.accessToken).toBe(session.accessToken);
  });

  it("signs differently with a different secret", async () => {
    const a = await createInMemorySessionStore({ secret: "s1" }).createSession({ sub: "u" });
    const b = await createInMemorySessionStore({ secret: "s2" }).createSession({ sub: "u" });
    expect(a.accessToken).not.toBe(b.accessToken);
  });

  it("defaults the session id to the subject", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const session = await store.createSession({ sub: "subject-1", displayName: "S" });
    expect(session.id).toBe("subject-1");
  });

  it("prefers an explicit id over the subject", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const session = await store.createSession({ id: "explicit-id", sub: "subject-1" });
    expect(session.id).toBe("explicit-id");
  });

  it("generates a random id when neither id nor sub is given", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const session = await store.createSession({ displayName: "No Sub" });
    expect(session.id).toBeTruthy();
    expect(session.id).not.toBe("No Sub");
    expect(session.id.length).toBeGreaterThanOrEqual(16);
  });

  it("passes through refreshToken and expiresAt", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const expiresAt = new Date("2030-01-01T00:00:00Z");
    const session = await store.createSession({
      sub: "u",
      refreshToken: "rt-1",
      expiresAt,
    });
    expect(session.refreshToken).toBe("rt-1");
    expect(session.expiresAt).toEqual(expiresAt);
  });

  it("verifies tokens and returns the principal with default scopes", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const session = await store.createSession({ sub: "user-1" });
    const principal = await store.verifyAccessToken(session.accessToken);
    expect(principal).toEqual({ sub: "user-1", scopes: ["dashboard"] });
  });

  it("keeps custom scopes on the principal", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const session = await store.createSession({ sub: "u", scopes: ["admin", "dashboard"] });
    const principal = await store.verifyAccessToken(session.accessToken);
    expect(principal?.scopes).toEqual(["admin", "dashboard"]);
  });

  it("rejects malformed tokens", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    await store.createSession({ sub: "user-1" });
    expect(await store.verifyAccessToken("")).toBeNull();
    expect(await store.verifyAccessToken("no-dot")).toBeNull();
    expect(await store.verifyAccessToken(".sig")).toBeNull();
    expect(await store.verifyAccessToken("user-1.")).toBeNull();
    expect(await store.verifyAccessToken("user-1.deadbeef")).toBeNull();
  });

  it("rejects tokens for sessions that do not exist", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const forged = `${"ghost"}.${await hmac("ghost", "s")}`;
    expect(await store.verifyAccessToken(forged)).toBeNull();
  });

  it("rejects tokens signed for a different session id", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    await store.createSession({ sub: "user-1" });
    const token = `${"user-2"}.${await hmac("user-1", "s")}`;
    expect(await store.verifyAccessToken(token)).toBeNull();
  });

  it("returns null for an expired session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const store = createInMemorySessionStore({ secret: "s" });
    const past = new Date("2024-12-31T23:59:59Z");
    const session = await store.createSession({ sub: "u", expiresAt: past });
    expect(await store.verifyAccessToken(session.accessToken)).toBeNull();
  });

  it("accepts a token before expiry and rejects it after", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const store = createInMemorySessionStore({ secret: "s" });
    const session = await store.createSession({
      sub: "u",
      expiresAt: new Date("2025-01-01T01:00:00Z"),
    });
    expect(await store.verifyAccessToken(session.accessToken)).not.toBeNull();

    vi.setSystemTime(new Date("2025-01-01T02:00:00Z"));
    expect(await store.verifyAccessToken(session.accessToken)).toBeNull();
  });

  it("getSession returns the stored session with its access token", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const session = await store.createSession({ sub: "u", displayName: "U" });
    const stored = await store.getSession("u");
    expect(stored?.id).toBe("u");
    expect(stored?.displayName).toBe("U");
    expect(stored?.accessToken).toBe(session.accessToken);
  });

  it("getSession returns null for unknown sessions", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    expect(await store.getSession("nope")).toBeNull();
  });

  it("revokeSession makes both getSession and verifyAccessToken return null", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const session = await store.createSession({ sub: "u" });
    await store.revokeSession("u");
    expect(await store.getSession("u")).toBeNull();
    expect(await store.verifyAccessToken(session.accessToken)).toBeNull();
  });

  it("revoking an unknown session is a no-op", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    await expect(store.revokeSession("ghost")).resolves.toBeUndefined();
    await store.createSession({ sub: "u" });
    expect(await store.getSession("u")).not.toBeNull();
  });

  it("revoked sessions stay revoked even with a valid signature", async () => {
    const store = createInMemorySessionStore({ secret: "s" });
    const session = await store.createSession({ sub: "u" });
    await store.revokeSession("u");
    // Re-derive the token; it is still signed correctly but must be rejected.
    const token = `u.${await hmac("u", "s")}`;
    expect(token).toBe(session.accessToken);
    expect(await store.verifyAccessToken(token)).toBeNull();
  });

  it("keeps sessions isolated between store instances", async () => {
    const storeA = createInMemorySessionStore({ secret: "s" });
    const storeB = createInMemorySessionStore({ secret: "s" });
    const a = await storeA.createSession({ sub: "u" });
    expect(await storeB.getSession("u")).toBeNull();
    expect(await storeB.verifyAccessToken(a.accessToken)).toBeNull();
  });
});
