import { describe, expect, it } from "vitest";
import {
  EgressProxyRuleSchema,
  EgressProxyStatusSchema,
  SecretBundleSchema,
  SecretImportSchema,
} from "./egress-proxy";

describe("EgressProxyRuleSchema", () => {
  it("parses allow/deny/rewrite rules", () => {
    const allow = EgressProxyRuleSchema.parse({ id: "r1", pattern: "*", action: "allow" });
    const rewrite = EgressProxyRuleSchema.parse({
      id: "r2",
      pattern: "http://old*",
      action: "rewrite",
      target: "http://new",
    });
    expect(allow.action).toBe("allow");
    expect(rewrite.target).toBe("http://new");
    expect(rewrite.action).toBe("rewrite");
  });

  it("rejects an unknown action and missing required fields", () => {
    expect(
      EgressProxyRuleSchema.safeParse({ id: "r1", pattern: "*", action: "proxy" }).success,
    ).toBe(false);
    expect(EgressProxyRuleSchema.safeParse({ pattern: "*", action: "allow" }).success).toBe(false);
    expect(EgressProxyRuleSchema.safeParse({ id: "r1", action: "allow" }).success).toBe(false);
  });
});

describe("EgressProxyStatusSchema", () => {
  it("parses status with rules and defaults rules to []", () => {
    const withRules = EgressProxyStatusSchema.parse({
      running: true,
      port: 8080,
      rules: [{ id: "r1", pattern: "*", action: "deny" }],
    });
    expect(withRules.rules).toHaveLength(1);

    const without = EgressProxyStatusSchema.parse({ running: false });
    expect(without.rules).toEqual([]);
    expect(without.port).toBeUndefined();
  });

  it("rejects a missing running flag", () => {
    expect(EgressProxyStatusSchema.safeParse({ port: 8080 }).success).toBe(false);
  });
});

describe("SecretImportSchema", () => {
  it("parses a secret import with default source", () => {
    const parsed = SecretImportSchema.parse({ key: "API_KEY", value: "sk-123" });
    expect(parsed.source).toBe("env");
  });

  it("accepts file and vault sources", () => {
    expect(SecretImportSchema.parse({ key: "k", value: "v", source: "file" }).source).toBe("file");
    expect(SecretImportSchema.parse({ key: "k", value: "v", source: "vault" }).source).toBe("vault");
  });

  it("rejects an unknown source or missing key/value", () => {
    expect(SecretImportSchema.safeParse({ key: "k", value: "v", source: "cloud" }).success).toBe(false);
    expect(SecretImportSchema.safeParse({ key: "k" }).success).toBe(false);
    expect(SecretImportSchema.safeParse({ value: "v" }).success).toBe(false);
  });
});

describe("SecretBundleSchema", () => {
  it("parses a bundle and defaults secrets to {}", () => {
    const parsed = SecretBundleSchema.parse({});
    expect(parsed.secrets).toEqual({});
    expect(parsed.importedAt).toBeUndefined();
  });

  it("keeps secrets and validates importedAt as a datetime", () => {
    const parsed = SecretBundleSchema.parse({
      secrets: { A: "1" },
      importedAt: "2026-01-01T00:00:00Z",
    });
    expect(parsed.secrets).toEqual({ A: "1" });
    expect(parsed.importedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("rejects a malformed datetime", () => {
    const result = SecretBundleSchema.safeParse({ importedAt: "yesterday" });
    expect(result.success).toBe(false);
  });
});
