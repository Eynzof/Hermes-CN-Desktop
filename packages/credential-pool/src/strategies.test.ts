import { afterEach, describe, expect, it, vi } from "vitest";
import { selectCredential } from "./strategies.js";
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

describe("selectCredential", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for an empty list", () => {
    expect(selectCredential([], "fill_first")).toBeNull();
  });

  it("fill_first picks the entry with the fewest requests", () => {
    const entries = [makeCred("a", { request_count: 3 }), makeCred("b", { request_count: 1 })];
    expect(selectCredential(entries, "fill_first")?.id).toBe("b");
  });

  it("fill_first keeps the first entry on ties", () => {
    const entries = [makeCred("a", { request_count: 1 }), makeCred("b", { request_count: 1 })];
    expect(selectCredential(entries, "fill_first")?.id).toBe("a");
  });

  it("least_used behaves like fill_first (lowest request_count)", () => {
    const entries = [
      makeCred("a", { request_count: 5 }),
      makeCred("b", { request_count: 2 }),
      makeCred("c", { request_count: 9 }),
    ];
    expect(selectCredential(entries, "least_used")?.id).toBe("b");
  });

  it("round_robin walks entries with the cursor", () => {
    const entries = [makeCred("a"), makeCred("b"), makeCred("c")];
    expect(selectCredential(entries, "round_robin", 0)?.id).toBe("a");
    expect(selectCredential(entries, "round_robin", 1)?.id).toBe("b");
    expect(selectCredential(entries, "round_robin", 2)?.id).toBe("c");
    // Cursor wraps modulo the available list length.
    expect(selectCredential(entries, "round_robin", 3)?.id).toBe("a");
    expect(selectCredential(entries, "round_robin", 7)?.id).toBe("b");
  });

  it("round_robin ignores exhausted/dead entries when advancing", () => {
    const entries = [
      makeCred("a", { last_status: "exhausted" }),
      makeCred("b"),
      makeCred("c", { last_status: "dead" }),
      makeCred("d"),
    ];
    // Available = [b, d]; cursor 3 -> 3 % 2 = 1 -> d.
    expect(selectCredential(entries, "round_robin", 3)?.id).toBe("d");
  });

  it("random returns an available entry deterministically when stubbed", () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.999);
    const entries = [makeCred("a"), makeCred("b"), makeCred("c")];
    expect(selectCredential(entries, "random")?.id).toBe("c");
    spy.mockReturnValue(0);
    expect(selectCredential(entries, "random")?.id).toBe("a");
  });

  it("excludes exhausted entries from every strategy", () => {
    const entries = [makeCred("a", { last_status: "exhausted" }), makeCred("b")];
    expect(selectCredential(entries, "fill_first")?.id).toBe("b");
    expect(selectCredential(entries, "least_used")?.id).toBe("b");
    expect(selectCredential(entries, "round_robin", 0)?.id).toBe("b");
    expect(selectCredential(entries, "random")?.id).toBe("b");
  });

  it("excludes dead entries from every strategy", () => {
    const entries = [makeCred("a", { last_status: "dead" }), makeCred("b", { last_status: "dead" })];
    expect(selectCredential(entries, "fill_first")).toBeNull();
    expect(selectCredential(entries, "least_used")).toBeNull();
    expect(selectCredential(entries, "round_robin", 0)).toBeNull();
    expect(selectCredential(entries, "random")).toBeNull();
  });

  it("treats undefined last_status (ok) entries as available", () => {
    const entries = [makeCred("a", { last_status: "ok" }), makeCred("b")];
    // Both are available; fill_first keeps the first entry on ties.
    expect(selectCredential(entries, "fill_first")?.id).toBe("a");
  });

  it("falls back to the first available entry for unknown strategies", () => {
    const entries = [makeCred("a"), makeCred("b")];
    const picked = selectCredential(entries, "bogus" as never);
    expect(picked?.id).toBe("a");
  });

  it("does not mutate the entries array", () => {
    const entries = [makeCred("a", { request_count: 2 }), makeCred("b", { request_count: 1 })];
    const snapshot = entries.map((e) => ({ ...e }));
    selectCredential(entries, "least_used");
    expect(entries).toEqual(snapshot);
  });
});
