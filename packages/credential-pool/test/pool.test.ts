import { describe, expect, it } from "vitest";
import { CredentialPool } from "../src/index.js";
import type { PooledCredential } from "../src/types.js";

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
  it("selects by fill_first", () => {
    const pool = new CredentialPool("test", [makeCred("a", { request_count: 1 }), makeCred("b")]);
    const picked = pool.select();
    expect(picked?.id).toBe("b");
    expect(picked?.request_count).toBe(1);
  });

  it("marks exhausted and rotates", () => {
    const pool = new CredentialPool("test", [makeCred("a"), makeCred("b")]);
    const next = pool.markExhaustedAndRotate({ statusCode: 429, credentialId: "a" });
    expect(next?.id).toBe("b");
    const a = pool.entriesList().find((e) => e.id === "a");
    expect(a?.last_status).toBe("exhausted");
  });

  it("returns null when all exhausted", () => {
    const pool = new CredentialPool("test", [makeCred("a")]);
    pool.markExhaustedAndRotate({ statusCode: 429, credentialId: "a" });
    expect(pool.hasAvailable()).toBe(false);
    expect(pool.select()).toBeNull();
  });
});
