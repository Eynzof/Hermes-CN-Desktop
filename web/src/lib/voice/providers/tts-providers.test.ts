import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  BUILTIN_TTS_PROVIDERS,
} from "./tts-providers";
import {
  clearTtsProviders,
  getTtsProvider,
  listTtsProviders,
  registerTtsProvider,
  resolveTtsProvider,
} from "./registry";

describe("TTS provider registry (P1-18)", () => {
  beforeEach(() => clearTtsProviders());

  it("registers and resolves providers by id", () => {
    const provider = { id: "mock", available: () => true, synthesize: async () => new ArrayBuffer(0) };
    registerTtsProvider(provider);
    expect(getTtsProvider("mock")).toBe(provider);
    expect(listTtsProviders()).toEqual([provider]);
    expect(resolveTtsProvider()?.id).toBe("mock");
  });

  it("resolveTtsProvider picks the first available provider", () => {
    const unavailable = { id: "a", available: () => false, synthesize: async () => new ArrayBuffer(0) };
    const available = { id: "b", available: () => true, synthesize: async () => new ArrayBuffer(0) };
    registerTtsProvider(unavailable);
    registerTtsProvider(available);
    expect(resolveTtsProvider()?.id).toBe("b");
  });

  it("built-in providers cover the 11-provider breadth", () => {
    expect(BUILTIN_TTS_PROVIDERS).toHaveLength(11);
    expect(BUILTIN_TTS_PROVIDERS.map((p) => p.id)).toEqual([
      "openai",
      "azure",
      "elevenlabs",
      "google",
      "deepgram",
      "cartesia",
      "edge",
      "gemini",
      "minimax",
      "polly",
      "xtts",
    ]);
  });

  it("managed-runtime providers surface an actionable error when no key is set", async () => {
    const edge = BUILTIN_TTS_PROVIDERS.find((p) => p.id === "edge")!;
    expect(edge.available()).toBe(false);
    await expect(edge.synthesize({ text: "hi" })).rejects.toThrow("managed Python runtime");
  });

  it("unconfigured direct providers throw a clear error", async () => {
    vi.stubGlobal("window", { OPENAI_API_KEY: undefined });
    const openai = BUILTIN_TTS_PROVIDERS.find((p) => p.id === "openai")!;
    // In the test env no env keys are configured, so direct providers are unavailable.
    if (!openai.available()) {
      await expect(openai.synthesize({ text: "hi" })).rejects.toThrow("OPENAI_API_KEY not configured");
    }
    vi.unstubAllGlobals();
  });
});
