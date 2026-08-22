import { describe, expect, it } from "vitest";
import { clearProviders, registerProvider } from "./registry.js";
import { switchModel, resolveEffectiveModel, type ModelSwitchScope } from "./switch.js";
import type { ProfileSnapshot } from "../types.js";
import type { ProviderProfile } from "./profile.js";

function fakeProvider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    slug: "openai",
    name: "OpenAI",
    apiMode: "chat_completions",
    authKind: "api_key",
    ...overrides,
  };
}

function baseProfile(): ProfileSnapshot {
  return {
    model: "gpt-4o",
    provider: "openai",
    apiMode: "chat_completions",
  };
}

describe("switchModel", () => {
  it("returns an error when no model is specified", async () => {
    const result = await switchModel(
      { target: "", scope: "per-session" },
      { currentProfile: baseProfile() },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("No model");
  });

  it("per-session switch does not persist globally", async () => {
    clearProviders();
    registerProvider(
      fakeProvider({ slug: "anthropic", name: "Anthropic", apiMode: "anthropic_messages" }),
    );
    const sessions: Array<{ sessionId: string; profile: ProfileSnapshot }> = [];
    const globals: Array<{ model: string; provider?: string }> = [];

    const result = await switchModel(
      { target: "claude-opus", scope: "per-session", sessionId: "s1" },
      {
        currentProfile: baseProfile(),
        persistSession: async (sessionId, profile) => {
          sessions.push({ sessionId, profile });
        },
        persistGlobal: async (model, provider) => {
          globals.push({ model, provider });
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.model).toBe("claude-opus-4-20250514");
    expect(result.provider).toBe("anthropic");
    expect(result.scope).toBe("per-session");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].profile.model).toBe("claude-opus-4-20250514");
    expect(globals).toHaveLength(0);
  });

  it("global switch persists to config and not session", async () => {
    clearProviders();
    registerProvider(fakeProvider({ slug: "openai" }));
    const sessions: Array<{ sessionId: string; profile: ProfileSnapshot }> = [];
    const globals: Array<{ model: string; provider?: string }> = [];

    const result = await switchModel(
      { target: "gpt-4o", scope: "global" },
      {
        currentProfile: baseProfile(),
        persistSession: async (sessionId, profile) => {
          sessions.push({ sessionId, profile });
        },
        persistGlobal: async (model, provider) => {
          globals.push({ model, provider });
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.scope).toBe("global");
    expect(sessions).toHaveLength(0);
    expect(globals).toHaveLength(1);
    expect(globals[0]).toEqual({ model: "gpt-4o", provider: "openai" });
  });

  it("once switch is not persisted", async () => {
    clearProviders();
    registerProvider(fakeProvider({ slug: "openai" }));
    const sessions: Array<{ sessionId: string; profile: ProfileSnapshot }> = [];
    const globals: Array<{ model: string; provider?: string }> = [];

    const result = await switchModel(
      { target: "gpt-4o-mini", scope: "once", sessionId: "s1" },
      {
        currentProfile: baseProfile(),
        persistSession: async (sessionId, profile) => {
          sessions.push({ sessionId, profile });
        },
        persistGlobal: async (model, provider) => {
          globals.push({ model, provider });
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.scope).toBe("once");
    expect(sessions).toHaveLength(0);
    expect(globals).toHaveLength(0);
  });

  it("supports explicit provider switch", async () => {
    clearProviders();
    registerProvider(
      fakeProvider({
        slug: "google",
        name: "Google",
        apiMode: "chat_completions",
        fallbackModels: ["gemini-2.5-pro"],
      }),
    );

    const result = await switchModel(
      { target: "gemini-2.5-pro", provider: "google", scope: "per-session", sessionId: "s1" },
      { currentProfile: baseProfile() },
    );

    expect(result.success).toBe(true);
    expect(result.provider).toBe("google");
    expect(result.providerChanged).toBe(true);
  });

  it.each([
    ["per-session", "per-session"],
    ["global", "global"],
    ["once", "once"],
  ] as [string, ModelSwitchScope][])("scope %s round-trips in result", async (input, expected) => {
    clearProviders();
    registerProvider(fakeProvider({ slug: "openai" }));
    const result = await switchModel(
      { target: "gpt-4o", scope: expected },
      { currentProfile: baseProfile() },
    );
    expect(result.scope).toBe(expected);
  });

  it("resolves credentials when a resolver is provided", async () => {
    clearProviders();
    registerProvider(fakeProvider({ slug: "openai" }));
    const result = await switchModel(
      { target: "gpt-4o", scope: "per-session", sessionId: "s1" },
      {
        currentProfile: baseProfile(),
        resolveCredentials: async (provider) => {
          return { apiKey: "sk-test", baseUrl: "https://example.com" };
        },
      },
    );
    expect(result.success).toBe(true);
    expect(result.apiKey).toBe("sk-test");
    expect(result.baseUrl).toBe("https://example.com");
  });
});

describe("resolveEffectiveModel", () => {
  it("session overrides channel and global", () => {
    const result = resolveEffectiveModel(
      { model: "session-model", provider: "a" },
      { model: "channel-model", provider: "b" },
      { model: "global-model", provider: "c" },
    );
    expect(result).toEqual({ model: "session-model", provider: "a" });
  });

  it("channel overrides global", () => {
    const result = resolveEffectiveModel(
      null,
      { model: "channel-model", provider: "b" },
      { model: "global-model", provider: "c" },
    );
    expect(result).toEqual({ model: "channel-model", provider: "b" });
  });

  it("global is the fallback", () => {
    const result = resolveEffectiveModel(null, null, { model: "global-model", provider: "c" });
    expect(result).toEqual({ model: "global-model", provider: "c" });
  });

  it("returns empty identity when nothing is set", () => {
    expect(resolveEffectiveModel(null, null, null)).toEqual({ model: "", provider: "" });
  });
});
