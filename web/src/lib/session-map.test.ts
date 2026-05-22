import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetUiStoreForTests, readUiValue, writeUiValue } from "./ui-store";
import {
  rememberSessionMapping,
  resolveGatewaySessionId,
  resolvePersistentSessionId,
} from "./session-map";

describe("session-map", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("maps gateway session ids to persistent session ids", () => {
    rememberSessionMapping("gw-1", "20260426_000000_abcd");
    expect(resolvePersistentSessionId("gw-1")).toBe("20260426_000000_abcd");
    expect(resolvePersistentSessionId("already-persistent")).toBe("already-persistent");
  });

  it("resolves persistent session ids back to active gateway ids", () => {
    rememberSessionMapping("gw-1", "20260426_000000_abcd");
    expect(resolveGatewaySessionId("20260426_000000_abcd")).toBe("gw-1");
    expect(resolveGatewaySessionId("unknown")).toBeUndefined();
  });

  it("expires entries older than 24 hours", () => {
    rememberSessionMapping("gw-old", "sess-old");
    const raw = readUiValue<Record<string, { persistentId: string; ts: number }>>(
      "hermes:gateway-session-map",
      {},
    );
    raw["gw-old"].ts = Date.now() - 25 * 60 * 60 * 1000;
    writeUiValue("hermes:gateway-session-map", raw);

    expect(resolvePersistentSessionId("gw-old")).toBe("gw-old");
    expect(resolveGatewaySessionId("sess-old")).toBeUndefined();
  });

  it("migrates legacy string-value format", () => {
    writeUiValue("hermes:gateway-session-map", { "gw-legacy": "sess-legacy" });
    expect(resolvePersistentSessionId("gw-legacy")).toBe("sess-legacy");
    expect(resolveGatewaySessionId("sess-legacy")).toBe("gw-legacy");
  });

  it("prunes to 200 entries keeping newest", () => {
    const now = Date.now();
    const map: Record<string, { persistentId: string; ts: number }> = {};
    for (let i = 0; i < 210; i++) {
      map[`gw-${i}`] = { persistentId: `sess-${i}`, ts: now - (210 - i) * 1000 };
    }
    writeUiValue("hermes:gateway-session-map", map);

    rememberSessionMapping("gw-new", "sess-new");

    expect(resolvePersistentSessionId("gw-0")).toBe("gw-0");
    expect(resolvePersistentSessionId("gw-9")).toBe("gw-9");
    expect(resolvePersistentSessionId("gw-209")).toBe("sess-209");
    expect(resolvePersistentSessionId("gw-new")).toBe("sess-new");
  });

  it("handles malformed UI store payloads gracefully", () => {
    writeUiValue("hermes:gateway-session-map", {
      "gw-1": { persistentId: 42, ts: "bad" },
    });
    expect(resolvePersistentSessionId("gw-1")).toBe("gw-1");
    expect(resolveGatewaySessionId("sess-1")).toBeUndefined();
  });

  it("no-ops when gateway and persistent ids are the same", () => {
    rememberSessionMapping("same-id", "same-id");
    expect(resolvePersistentSessionId("same-id")).toBe("same-id");
    expect(resolveGatewaySessionId("same-id")).toBeUndefined();
  });

  it("overwrites mapping when same gateway id is re-mapped", () => {
    rememberSessionMapping("gw-1", "sess-old");
    rememberSessionMapping("gw-1", "sess-new");
    expect(resolvePersistentSessionId("gw-1")).toBe("sess-new");
  });

  it("returns undefined for undefined input", () => {
    expect(resolvePersistentSessionId(undefined)).toBeUndefined();
    expect(resolveGatewaySessionId(undefined)).toBeUndefined();
  });
});
