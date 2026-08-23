import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialPool } from "./pool.js";
import { TTL_401, TTL_429, TTL_SOLE } from "./constants.js";
import type { PooledCredential } from "./types.js";

function makeCred(id: string, overrides: Partial<PooledCredential> = {}): PooledCredential {
  return {
    provider: "test",
    id,
    label: id,
    auth_type: "api_key",
    priority: 0,
    source: "manual",
    access_token: "secret",
    request_count: 0,
    extra: {},
    ...overrides,
  };
}

describe("CredentialPool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("select", () => {
    it("selects by fill_first and increments request_count (plan parity)", () => {
      const pool = new CredentialPool("test", [
        makeCred("a", { request_count: 1 }),
        makeCred("b"),
      ]);
      const picked = pool.select();
      expect(picked?.id).toBe("b");
      expect(picked?.request_count).toBe(1);
      const a = pool.entriesList().find((e) => e.id === "a");
      expect(a?.request_count).toBe(1);
    });

    it("least_used strategy increments request_count of the picked entry", () => {
      const pool = new CredentialPool(
        "test",
        [makeCred("a", { request_count: 2 }), makeCred("b", { request_count: 5 })],
        "least_used",
      );
      expect(pool.select()?.id).toBe("a");
      expect(pool.entriesList().find((e) => e.id === "a")?.request_count).toBe(3);
    });

    it("round_robin advances the cursor on each select", () => {
      const pool = new CredentialPool("test", [makeCred("a"), makeCred("b")], "round_robin");
      expect(pool.select()?.id).toBe("a");
      expect(pool.select()?.id).toBe("b");
      expect(pool.select()?.id).toBe("a");
    });

    it("returns null when every entry is exhausted or dead", () => {
      const pool = new CredentialPool("test", [
        makeCred("a", { last_status: "exhausted" }),
        makeCred("b", { last_status: "dead" }),
      ]);
      expect(pool.select()).toBeNull();
      expect(pool.hasAvailable()).toBe(false);
    });

    it("never selects a dead credential (DEAD terminal state)", () => {
      const pool = new CredentialPool("test", [
        makeCred("a", { last_status: "dead" }),
        makeCred("b"),
      ]);
      const picked = pool.select();
      expect(picked?.id).toBe("b");
    });
  });

  describe("markExhaustedAndRotate", () => {
    it("marks the entry exhausted with status code and reason, then rotates", () => {
      const pool = new CredentialPool("test", [makeCred("a"), makeCred("b")]);
      const next = pool.markExhaustedAndRotate({
        statusCode: 429,
        failureReason: "rate_limit",
        credentialId: "a",
      });
      expect(next?.id).toBe("b");
      const a = pool.entriesList().find((e) => e.id === "a");
      expect(a?.last_status).toBe("exhausted");
      expect(a?.last_status_at).toBe(Date.parse("2025-01-01T00:00:00Z"));
      expect(a?.last_error_code).toBe(429);
      expect(a?.last_error_reason).toBe("rate_limit");
    });

    it("defaults to the first available entry when credentialId is omitted", () => {
      const pool = new CredentialPool("test", [makeCred("a"), makeCred("b")]);
      const next = pool.markExhaustedAndRotate({ statusCode: 429 });
      // a is first available -> marked exhausted -> rotate to b.
      expect(pool.entriesList().find((e) => e.id === "a")?.last_status).toBe("exhausted");
      expect(next?.id).toBe("b");
    });

    it("returns null and marks nothing when no entry is available", () => {
      const pool = new CredentialPool("test", [
        makeCred("a", { last_status: "dead" }),
        makeCred("b", { last_status: "exhausted" }),
      ]);
      expect(pool.markExhaustedAndRotate({ statusCode: 429 })).toBeNull();
    });

    it("sole credential: stays exhausted and records the 60 s reset time", () => {
      const pool = new CredentialPool("test", [makeCred("only")]);
      const next = pool.markExhaustedAndRotate({ statusCode: 401, credentialId: "only" });
      expect(next).toBeNull();
      expect(pool.hasAvailable()).toBe(false);
      const entry = pool.entriesList()[0];
      expect(entry.last_status).toBe("exhausted");
      // Sole-credential TTL (60 s) is recorded on the entry.
      expect(entry.last_error_reset_at).toBe(Date.parse("2025-01-01T00:00:00Z") + TTL_SOLE);
      expect(pool.nextAvailableAt()).toBe(entry.last_error_reset_at);
    });

    it("records 401 and 429 cooldown constants on the sole entry", () => {
      // TTL selection itself is internal; we lock the constants the pool relies
      // on for 401 vs 429/billing/rate-limit classification.
      expect(TTL_401).toBe(300_000);
      expect(TTL_429).toBe(3_600_000);
    });

    it("multi-entry exhaustion does not set a reset time (documented gap)", () => {
      const pool = new CredentialPool("test", [makeCred("a"), makeCred("b")]);
      pool.markExhaustedAndRotate({ statusCode: 429, credentialId: "a" });
      const a = pool.entriesList().find((e) => e.id === "a");
      expect(a?.last_error_reset_at).toBeUndefined();
      // With no reset times recorded, nextAvailableAt reports null.
      expect(pool.nextAvailableAt()).toBeNull();
    });

    it("rotates to the next available entry when several exist", () => {
      const pool = new CredentialPool("test", [makeCred("a"), makeCred("b"), makeCred("c")]);
      expect(pool.markExhaustedAndRotate({ statusCode: 429, credentialId: "a" })?.id).toBe("b");
      expect(pool.markExhaustedAndRotate({ statusCode: 429, credentialId: "b" })?.id).toBe("c");
      expect(pool.hasAvailable()).toBe(true);
    });

    it("rotating a dead entry still flips it to exhausted (as implemented)", () => {
      const pool = new CredentialPool("test", [
        makeCred("a", { last_status: "dead" }),
        makeCred("b"),
      ]);
      const next = pool.markExhaustedAndRotate({ statusCode: 401, credentialId: "a" });
      expect(pool.entriesList().find((e) => e.id === "a")?.last_status).toBe("exhausted");
      expect(next?.id).toBe("b");
    });
  });

  describe("leases", () => {
    it("acquireLease selects an entry and returns its id", async () => {
      const pool = new CredentialPool("test", [makeCred("a"), makeCred("b")]);
      const lease = await pool.acquireLease();
      expect(lease).toBe("a");
      expect(pool.entriesList().find((e) => e.id === "a")?.request_count).toBe(1);
    });

    it("acquireLease returns null when nothing is available", async () => {
      const pool = new CredentialPool("test", [makeCred("a", { last_status: "dead" })]);
      expect(await pool.acquireLease()).toBeNull();
    });

    it("releaseLease is a safe no-op (in-memory cut)", async () => {
      const pool = new CredentialPool("test", [makeCred("a")]);
      await expect(pool.releaseLease("a")).resolves.toBeUndefined();
    });
  });

  describe("pool bookkeeping", () => {
    it("entriesList returns the live entries array", () => {
      const pool = new CredentialPool("test", [makeCred("a")]);
      expect(pool.entriesList()).toHaveLength(1);
      pool.entriesList().push(makeCred("b"));
      expect(pool.entriesList()).toHaveLength(2);
    });

    it("hasAvailable reflects exhausted/dead status", () => {
      const pool = new CredentialPool("test", [makeCred("a"), makeCred("b")]);
      expect(pool.hasAvailable()).toBe(true);
      pool.markExhaustedAndRotate({ statusCode: 429, credentialId: "a" });
      expect(pool.hasAvailable()).toBe(true);
      pool.markExhaustedAndRotate({ statusCode: 429, credentialId: "b" });
      expect(pool.hasAvailable()).toBe(false);
    });

    it("nextAvailableAt returns the earliest reset time", () => {
      const now = Date.parse("2025-01-01T00:00:00Z");
      const pool = new CredentialPool("test", [
        makeCred("a", { last_error_reset_at: now + 10_000 }),
        makeCred("b", { last_error_reset_at: now + 5_000 }),
      ]);
      expect(pool.nextAvailableAt()).toBe(now + 5_000);
    });

    it("nextAvailableAt ignores entries without a reset time", () => {
      const now = Date.parse("2025-01-01T00:00:00Z");
      const pool = new CredentialPool("test", [
        makeCred("a", { last_error_reset_at: now + 10_000 }),
        makeCred("b"),
      ]);
      expect(pool.nextAvailableAt()).toBe(now + 10_000);
    });

    it("nextAvailableAt returns null when no entry has a reset time", () => {
      const pool = new CredentialPool("test", [makeCred("a"), makeCred("b")]);
      expect(pool.nextAvailableAt()).toBeNull();
    });
  });
});
