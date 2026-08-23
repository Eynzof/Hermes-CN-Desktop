import { describe, expect, expectTypeOf, it } from "vitest";
import * as profileModule from "./profile.js";
import type {
  ProviderAuthKind,
  ProviderCapabilities,
  ProviderHooks,
  ProviderProfile,
} from "./profile.js";
import type { ProviderApiMode, Message, Tool } from "../types.js";

/**
 * `profile.ts` is a types-only module (interfaces + type aliases, no runtime
 * exports). These tests lock the type contract with compile-time assertions
 * (`expectTypeOf` is typechecked by `tsc --noEmit`) and verify the module has
 * no accidental runtime side effects.
 */
describe("provider profile type contract", () => {
  it("is a types-only module with no runtime exports", () => {
    expect(Object.keys(profileModule)).toEqual([]);
  });

  it("defines the full ProviderAuthKind union", () => {
    expectTypeOf<ProviderAuthKind>().toEqualTypeOf<
      "api_key" | "oauth" | "token_credential" | "service_account" | "adc" | "none"
    >();
  });

  it("keeps every ProviderCapabilities flag optional", () => {
    expectTypeOf<ProviderCapabilities>().toMatchTypeOf<{
      streaming?: boolean;
      supportsTools?: boolean;
      supportsVision?: boolean;
      supportsReasoning?: boolean;
      supportsPromptCacheKey?: boolean;
    }>();
    const caps: ProviderCapabilities = {};
    expect(caps.streaming).toBeUndefined();
  });

  it("types ProviderHooks prepareMessages/buildExtraBody against Message[] and Tool[]", () => {
    expectTypeOf<ProviderHooks>().toMatchTypeOf<{
      prepareMessages?: (messages: Message[], tools: Tool[]) => Message[];
      buildExtraBody?: (messages: Message[], tools: Tool[]) => Record<string, unknown> | undefined;
    }>();
  });

  it("requires slug, name and apiMode on ProviderProfile", () => {
    expectTypeOf<ProviderProfile>().toMatchTypeOf<{
      slug: string;
      name: string;
      apiMode: ProviderApiMode;
    }>();
    const profile: ProviderProfile = {
      slug: "openai",
      name: "OpenAI",
      apiMode: "chat_completions",
      authKind: "api_key",
    };
    expect(profile.slug).toBe("openai");
  });

  it("allows optional profile fields to be omitted", () => {
    const minimal: ProviderProfile = {
      slug: "local",
      name: "Local",
      apiMode: "chat_completions",
      authKind: "none",
    };
    expect(minimal.baseUrl).toBeUndefined();
    expect(minimal.model).toBeUndefined();
    expect(minimal.fallbackModels).toBeUndefined();
    expect(minimal.capabilities).toBeUndefined();
    expect(minimal.hooks).toBeUndefined();
    expect(minimal.fetchModels).toBeUndefined();
    expect(minimal.modelsUrl).toBeUndefined();
  });

  it("types fetchModels as a baseUrl+apiKey → Promise<string[]> function", () => {
    expectTypeOf<ProviderProfile["fetchModels"]>().toEqualTypeOf<
      | ((baseUrl: string, apiKey?: string) => Promise<string[]>)
      | undefined
    >();
  });

  it("accepts apiMode values from the ProviderApiMode union", () => {
    const modes: ProviderApiMode[] = [
      "chat_completions",
      "codex_responses",
      "anthropic_messages",
      "bedrock_converse",
      "codex_app_server",
    ];
    for (const mode of modes) {
      const profile: ProviderProfile = { slug: "p", name: "P", apiMode: mode, authKind: "api_key" };
      expect(profile.apiMode).toBe(mode);
    }
  });
});
