import { describe, expect, it } from "vitest";
import { formatModelSwitchCommand, parseModelSwitchArgs } from "./model";

describe("parseModelSwitchArgs", () => {
  it("parses plain model name", () => {
    const result = parseModelSwitchArgs("gpt-4o");
    expect(result.target).toBe("gpt-4o");
    expect(result.scope).toBe("per-session");
    expect(result.errors).toEqual([]);
  });

  it("parses --global", () => {
    const result = parseModelSwitchArgs("sonnet --global");
    expect(result.target).toBe("sonnet");
    expect(result.scope).toBe("global");
  });

  it("parses --once", () => {
    const result = parseModelSwitchArgs("--once claude-opus");
    expect(result.target).toBe("claude-opus");
    expect(result.scope).toBe("once");
  });

  it("errors when --once has no target", () => {
    const result = parseModelSwitchArgs("--once");
    expect(result.errors).toContain("--once requires a target model");
  });

  it("parses --provider", () => {
    const result = parseModelSwitchArgs("gemini-2.5-pro --provider google");
    expect(result.target).toBe("gemini-2.5-pro");
    expect(result.provider).toBe("google");
  });

  it("errors when --provider is missing a value", () => {
    const result = parseModelSwitchArgs("gpt-4o --provider");
    expect(result.errors).toContain("--provider requires a value");
  });

  it("parses --refresh", () => {
    const result = parseModelSwitchArgs("gpt-4o --refresh");
    expect(result.forceRefresh).toBe(true);
  });

  it("normalizes unicode dashes", () => {
    const result = parseModelSwitchArgs("gpt-4o \u2013global");
    expect(result.scope).toBe("global");
  });

  it("reports conflicting scope flags", () => {
    const result = parseModelSwitchArgs("gpt-4o --global --once");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Cannot combine");
  });

  it("keeps scope when only one flag present", () => {
    const result = parseModelSwitchArgs("--session gpt-4o");
    expect(result.scope).toBe("per-session");
    expect(result.errors).toEqual([]);
  });

  it("preserves model id with spaces", () => {
    const result = parseModelSwitchArgs("claude sonnet 4");
    expect(result.target).toBe("claude sonnet 4");
  });
});

describe("formatModelSwitchCommand", () => {
  it("formats a plain command", () => {
    expect(formatModelSwitchCommand({ target: "gpt-4o" })).toBe("/model gpt-4o");
  });

  it("includes --global", () => {
    expect(formatModelSwitchCommand({ target: "sonnet", scope: "global" })).toBe(
      "/model --global sonnet",
    );
  });

  it("includes --once", () => {
    expect(formatModelSwitchCommand({ target: "opus", scope: "once" })).toBe(
      "/model --once opus",
    );
  });

  it("includes provider", () => {
    expect(formatModelSwitchCommand({ target: "gemini", provider: "google" })).toBe(
      "/model --provider google gemini",
    );
  });
});
