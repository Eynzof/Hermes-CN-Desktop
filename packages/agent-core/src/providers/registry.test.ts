import { afterEach, describe, expect, it } from "vitest";
import {
  clearProviders,
  getProvider,
  listProviders,
  registerProvider,
  unregisterProvider,
} from "../index.js";
import type { ProviderProfile } from "../index.js";

describe("provider registry", () => {
  afterEach(() => {
    clearProviders();
  });

  it("registers and retrieves providers", () => {
    const profile: ProviderProfile = {
      slug: "openai",
      name: "OpenAI",
      apiMode: "chat_completions",
      authKind: "api_key",
    };

    registerProvider(profile);

    expect(getProvider("openai")?.name).toBe("OpenAI");
    expect(listProviders()).toHaveLength(1);
  });

  it("returns undefined for unknown providers", () => {
    expect(getProvider("unknown")).toBeUndefined();
  });

  it("unregisters a provider", () => {
    registerProvider({
      slug: "a",
      name: "A",
      apiMode: "chat_completions",
      authKind: "api_key",
    });
    expect(unregisterProvider("a")).toBe(true);
    expect(unregisterProvider("a")).toBe(false);
  });
});
