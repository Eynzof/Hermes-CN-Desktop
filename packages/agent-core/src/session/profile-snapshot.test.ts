import { describe, expect, it } from "vitest";
import {
  ContextFileSchema,
  ContextFileSourceSchema,
  PlatformIdentitySchema,
  ProfileSnapshotSchema,
  ProviderApiModeSchema,
  ReasoningConfigSchema,
} from "./profile-snapshot.js";

describe("ProviderApiModeSchema", () => {
  it("accepts every documented api mode", () => {
    for (const mode of [
      "chat_completions",
      "codex_responses",
      "anthropic_messages",
      "bedrock_converse",
      "codex_app_server",
    ]) {
      expect(ProviderApiModeSchema.parse(mode)).toBe(mode);
    }
  });

  it("rejects unknown modes", () => {
    for (const bad of ["unknown", "", "openai", 42, null, undefined]) {
      expect(ProviderApiModeSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("ContextFileSourceSchema", () => {
  it("accepts every documented source", () => {
    for (const source of ["hermes", "agents", "claude", "cursor", "soul"]) {
      expect(ContextFileSourceSchema.parse(source)).toBe(source);
    }
  });

  it("rejects unknown sources", () => {
    expect(ContextFileSourceSchema.safeParse("vscode").success).toBe(false);
    expect(ContextFileSourceSchema.safeParse("").success).toBe(false);
  });
});

describe("ContextFileSchema", () => {
  it("parses a minimal context file", () => {
    const parsed = ContextFileSchema.parse({ path: "/repo/AGENTS.md", source: "hermes", content: "# rules" });
    expect(parsed).toEqual({ path: "/repo/AGENTS.md", source: "hermes", content: "# rules" });
  });

  it("parses with provenance", () => {
    const parsed = ContextFileSchema.parse({
      path: "x.md",
      source: "claude",
      content: "",
      provenance: "CLAUDE.md",
    });
    expect(parsed.provenance).toBe("CLAUDE.md");
  });

  it("rejects missing required fields", () => {
    expect(ContextFileSchema.safeParse({}).success).toBe(false);
    expect(ContextFileSchema.safeParse({ path: "a", source: "hermes" }).success).toBe(false);
    expect(ContextFileSchema.safeParse({ path: "a", content: "c" }).success).toBe(false);
    expect(ContextFileSchema.safeParse({ path: "a", source: "bogus", content: "c" }).success).toBe(false);
  });
});

describe("ReasoningConfigSchema", () => {
  it("parses an empty config", () => {
    expect(ReasoningConfigSchema.parse({})).toEqual({});
  });

  it("parses a full config", () => {
    expect(ReasoningConfigSchema.parse({ effort: "high", budgetTokens: 2048, disabled: false })).toEqual({
      effort: "high",
      budgetTokens: 2048,
      disabled: false,
    });
  });

  it("accepts every effort level", () => {
    for (const effort of ["low", "medium", "high"]) {
      expect(ReasoningConfigSchema.parse({ effort }).effort).toBe(effort);
    }
  });

  it("rejects unknown effort levels", () => {
    expect(ReasoningConfigSchema.safeParse({ effort: "extreme" }).success).toBe(false);
  });

  it("requires budgetTokens to be a non-negative integer", () => {
    expect(ReasoningConfigSchema.safeParse({ budgetTokens: 0 }).success).toBe(true);
    expect(ReasoningConfigSchema.safeParse({ budgetTokens: 1.5 }).success).toBe(false);
    expect(ReasoningConfigSchema.safeParse({ budgetTokens: -1 }).success).toBe(false);
    expect(ReasoningConfigSchema.safeParse({ budgetTokens: "100" }).success).toBe(false);
  });

  it("strips unknown keys (default Zod object behavior)", () => {
    const parsed = ReasoningConfigSchema.parse({ effort: "low", extra: true });
    expect(parsed).toEqual({ effort: "low" });
    expect(parsed).not.toHaveProperty("extra");
  });
});

describe("PlatformIdentitySchema", () => {
  it("parses an empty identity", () => {
    expect(PlatformIdentitySchema.parse({})).toEqual({});
  });

  it("parses a full identity", () => {
    expect(
      PlatformIdentitySchema.parse({
        platform: "mattermost",
        userId: "u1",
        chatId: "c1",
        gatewaySessionKey: "k",
      }),
    ).toEqual({ platform: "mattermost", userId: "u1", chatId: "c1", gatewaySessionKey: "k" });
  });

  it("rejects non-object values", () => {
    expect(PlatformIdentitySchema.safeParse(null).success).toBe(false);
    expect(PlatformIdentitySchema.safeParse("x").success).toBe(false);
    expect(PlatformIdentitySchema.safeParse(42).success).toBe(false);
  });

  it("strips unknown keys (default Zod object behavior)", () => {
    const parsed = PlatformIdentitySchema.parse({ platform: "x", bogus: 1 });
    expect(parsed).toEqual({ platform: "x" });
    expect(parsed).not.toHaveProperty("bogus");
  });
});

describe("ProfileSnapshotSchema", () => {
  const valid: Record<string, unknown> = {
    model: "gpt-4o",
    provider: "openai",
    apiMode: "chat_completions",
  };

  it("parses a minimal snapshot", () => {
    const parsed = ProfileSnapshotSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it("parses a full snapshot", () => {
    const full = {
      ...valid,
      baseUrl: "https://example.com",
      apiKey: "sk-xxx",
      enabledToolsets: ["shell", "web"],
      disabledToolsets: ["meet"],
      skills: ["agile"],
      memoryProvider: "mem0",
      reasoningConfig: { effort: "medium", budgetTokens: 1000 },
      platformIdentity: { platform: "slack" },
      contextFiles: [{ path: "a", source: "agents", content: "c", provenance: "AGENTS.md" }],
    };
    const parsed = ProfileSnapshotSchema.parse(full);
    expect(parsed.contextFiles).toEqual(full.contextFiles);
    expect(parsed.reasoningConfig).toEqual(full.reasoningConfig);
  });

  it("requires model, provider, and apiMode", () => {
    expect(ProfileSnapshotSchema.safeParse({}).success).toBe(false);
    expect(ProfileSnapshotSchema.safeParse({ provider: "x", apiMode: "chat_completions" }).success).toBe(false);
    expect(ProfileSnapshotSchema.safeParse({ model: "x", apiMode: "chat_completions" }).success).toBe(false);
    expect(ProfileSnapshotSchema.safeParse({ model: "x", provider: "y" }).success).toBe(false);
  });

  it("rejects an invalid apiMode", () => {
    expect(
      ProfileSnapshotSchema.safeParse({ ...valid, apiMode: "not-a-mode" }).success,
    ).toBe(false);
  });

  it("passes through unknown top-level keys (passthrough)", () => {
    const parsed = ProfileSnapshotSchema.parse({ ...valid, customField: { anything: 1 } });
    expect(parsed.customField).toEqual({ anything: 1 });
  });

  it("validates nested contextFiles", () => {
    expect(
      ProfileSnapshotSchema.safeParse({ ...valid, contextFiles: [{ path: "a", source: "bogus", content: "c" }] })
        .success,
    ).toBe(false);
    expect(
      ProfileSnapshotSchema.safeParse({ ...valid, contextFiles: [{ path: "a" }] }).success,
    ).toBe(false);
  });

  it("validates nested reasoningConfig", () => {
    expect(
      ProfileSnapshotSchema.safeParse({ ...valid, reasoningConfig: { effort: "turbo" } }).success,
    ).toBe(false);
    expect(
      ProfileSnapshotSchema.safeParse({ ...valid, reasoningConfig: { budgetTokens: -5 } }).success,
    ).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(ProfileSnapshotSchema.safeParse(null).success).toBe(false);
    expect(ProfileSnapshotSchema.safeParse("x").success).toBe(false);
    expect(ProfileSnapshotSchema.safeParse([]).success).toBe(false);
  });
});
