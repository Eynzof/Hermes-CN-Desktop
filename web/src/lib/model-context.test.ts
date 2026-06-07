import { describe, expect, it } from "vitest";
import { resolveModelContextWindow } from "./model-context";

describe("resolveModelContextWindow", () => {
  it("reads per-model context from custom provider config", () => {
    const config = {
      custom_providers: [
        {
          name: "Cp.compshare.cn",
          models: {
            "glm-5.1": { context_length: 200_000 },
            "deepseek-v4-flash": { context_length: 1_000_000 },
          },
        },
      ],
      model_context_length: 1_000_000,
    };

    expect(resolveModelContextWindow(config, {
      provider: "custom:cp.compshare.cn",
      providerName: "Cp.compshare.cn",
      model: "glm-5.1",
    })).toBe(200_000);
  });

  it("does not use global model_context_length as a per-model value", () => {
    expect(resolveModelContextWindow(
      { model_context_length: 1_000_000 },
      { provider: "unknown", model: "unknown-model" },
    )).toBeUndefined();
  });

  it("matches configured providers by canonical provider id", () => {
    const config = {
      providers: {
        "cp.compshare.cn": {
          models: {
            "deepseek-ai/DeepSeek-V3.2": { context_length: 128_000 },
          },
        },
      },
    };

    expect(resolveModelContextWindow(config, {
      provider: "cp.compshare.cn",
      model: "deepseek-ai/DeepSeek-V3.2",
    })).toBe(128_000);
  });

  it("falls back to the built-in MiniMax-M3 catalog context", () => {
    expect(resolveModelContextWindow(undefined, {
      provider: "minimax-cn",
      model: "MiniMax-M3",
    })).toBe(1_000_000);
  });
});
