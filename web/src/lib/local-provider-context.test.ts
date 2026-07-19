import { describe, expect, it } from "vitest";
import {
  getLocalContextWarning,
  HERMES_CONTEXT_REQUIREMENTS_URL,
  HERMES_PROVIDER_CONTEXT_URL,
  MINIMUM_LOCAL_CONTEXT_LENGTH,
  parseLocalContextWindow,
  RECOMMENDED_LOCAL_CONTEXT_LENGTH,
} from "./local-provider-context";

describe("local provider context helpers", () => {
  it("exports stable documentation URLs for local provider onboarding", () => {
    expect(HERMES_CONTEXT_REQUIREMENTS_URL).toBe(
      "https://hermesagent.org.cn/en/docs/getting-started/quickstart",
    );
    expect(HERMES_PROVIDER_CONTEXT_URL).toBe(
      "https://hermes-agent.nousresearch.com/docs/integrations/providers",
    );
  });

  it("parses empty and invalid context windows as unset", () => {
    expect(parseLocalContextWindow("")).toBeUndefined();
    expect(parseLocalContextWindow("   ")).toBeUndefined();
    expect(parseLocalContextWindow("abc")).toBeUndefined();
    expect(parseLocalContextWindow("128k")).toBeUndefined();
    expect(parseLocalContextWindow("-5")).toBeUndefined();
  });

  it("parses positive numeric context windows", () => {
    expect(parseLocalContextWindow(String(RECOMMENDED_LOCAL_CONTEXT_LENGTH))).toBe(65_536);
    expect(parseLocalContextWindow("64000")).toBe(64_000);
    expect(parseLocalContextWindow("100.9")).toBe(100);
  });

  it("does not warn for empty, 64K, or recommended context values", () => {
    expect(getLocalContextWarning({ isLocalProvider: true, configuredContextWindow: "" })).toBeNull();
    expect(getLocalContextWarning({
      isLocalProvider: true,
      configuredContextWindow: String(MINIMUM_LOCAL_CONTEXT_LENGTH),
    })).toBeNull();
    expect(getLocalContextWarning({
      isLocalProvider: true,
      configuredContextWindow: String(RECOMMENDED_LOCAL_CONTEXT_LENGTH),
    })).toBeNull();
  });

  it("warns when the configured context is below the minimum", () => {
    const warning = getLocalContextWarning({
      isLocalProvider: true,
      configuredContextWindow: "63999",
    });
    expect(warning).toMatchObject({
      length: 63_999,
      source: "configured",
    });
    expect(warning?.message).toContain("64,000");
    expect(warning?.message).toContain("65,536");
  });

  it("warns when the current detected local context is below the minimum", () => {
    const warning = getLocalContextWarning({
      isLocalProvider: true,
      configuredContextWindow: "",
      effectiveContextLength: 4_096,
    });
    expect(warning).toMatchObject({
      length: 4_096,
      source: "detected",
    });
  });

  it("ignores local-only warnings for remote providers", () => {
    expect(getLocalContextWarning({
      isLocalProvider: false,
      configuredContextWindow: "4096",
      effectiveContextLength: 4_096,
    })).toBeNull();
  });
});
