import { describe, expect, it } from "vitest";
import {
  assertGatewayModelConfigResult,
  buildGatewayModelConfigValue,
  normalizeProviderIdForGateway,
} from "./provider-id";

describe("normalizeProviderIdForGateway", () => {
  it("preserves domain-shaped custom provider ids for exact Core lookup", () => {
    expect(normalizeProviderIdForGateway("custom:cp.compshare.cn")).toBe("custom:cp.compshare.cn");
  });

  it("keeps regular custom provider slugs intact", () => {
    expect(normalizeProviderIdForGateway("custom:local")).toBe("custom:local");
  });
});

describe("buildGatewayModelConfigValue", () => {
  it("includes an explicit provider flag for gateway model switches", () => {
    expect(buildGatewayModelConfigValue("kimi-k2.6", "kimi-for-coding"))
      .toBe("kimi-k2.6 --provider kimi-for-coding");
  });

  it("preserves domain-shaped custom provider ids before sending to gateway", () => {
    expect(buildGatewayModelConfigValue("deepseek-v4-flash", "custom:cp.compshare.cn"))
      .toBe("deepseek-v4-flash --provider custom:cp.compshare.cn");
  });

  it("rejects a selection without an explicit provider", () => {
    expect(() => buildGatewayModelConfigValue("deepseek-v4-flash")).toThrow(/服务商/);
  });
});

describe("assertGatewayModelConfigResult", () => {
  it("accepts Core's model-only success value", () => {
    expect(() => assertGatewayModelConfigResult(
      "deepseek-v4-flash --provider custom:acct-fengchihermes",
      "deepseek-v4-flash",
    )).not.toThrow();
  });

  it("accepts semantically identical values with normalized whitespace", () => {
    expect(() => assertGatewayModelConfigResult(
      "deepseek-chat   --provider   deepseek",
      "deepseek-chat --provider deepseek",
    )).not.toThrow();
  });

  it("throws when Core reports a different model", () => {
    expect(() => assertGatewayModelConfigResult(
      "deepseek-chat --provider deepseek",
      "claude-sonnet --provider anthropic",
    )).toThrow(/不一致/);
  });

  it("throws when Core echoes a different provider for the same model", () => {
    expect(() => assertGatewayModelConfigResult(
      "deepseek-chat --provider deepseek",
      "deepseek-chat --provider openrouter",
    )).toThrow(/不一致/);
  });

  it("throws when a model-only response names a different model", () => {
    expect(() => assertGatewayModelConfigResult(
      "deepseek-chat --provider deepseek",
      "deepseek-reasoner",
    )).toThrow(/不一致/);
  });

  it("accepts an exact round-trip", () => {
    expect(() => assertGatewayModelConfigResult(
      "deepseek-chat --provider deepseek",
      "deepseek-chat --provider deepseek",
    )).not.toThrow();
  });
});
