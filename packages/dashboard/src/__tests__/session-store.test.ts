import { describe, expect, it } from "vitest";
import { createInMemorySessionStore } from "../auth/session-store";

describe("createInMemorySessionStore", () => {
  it("creates a signed access token", async () => {
    const store = createInMemorySessionStore({ secret: "test-secret" });
    const session = await store.createSession({
      displayName: "Alice",
      sub: "basic:alice",
      scopes: ["dashboard"],
    });
    expect(session.id).toBeTruthy();
    expect(session.accessToken).toContain(".");
    expect(session.displayName).toBe("Alice");
  });

  it("verifies its own tokens", async () => {
    const store = createInMemorySessionStore({ secret: "test-secret" });
    const session = await store.createSession({ sub: "user-1" });
    const principal = await store.verifyAccessToken(session.accessToken);
    expect(principal).not.toBeNull();
    expect(principal?.sub).toBe("user-1");
  });

  it("rejects tampered tokens", async () => {
    const store = createInMemorySessionStore({ secret: "test-secret" });
    const session = await store.createSession({ sub: "user-1" });
    const tampered = session.accessToken.replace(/^[^.]+\./, "other.");
    expect(await store.verifyAccessToken(tampered)).toBeNull();
  });

  it("rejects revoked sessions", async () => {
    const store = createInMemorySessionStore({ secret: "test-secret" });
    const session = await store.createSession({ sub: "user-1" });
    await store.revokeSession(session.id);
    expect(await store.verifyAccessToken(session.accessToken)).toBeNull();
  });
});
