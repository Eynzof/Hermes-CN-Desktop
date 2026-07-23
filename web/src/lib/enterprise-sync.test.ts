import { describe, expect, it } from "vitest";
import {
  applyEnterpriseSync,
  ENTERPRISE_PROVIDER_PREFIX,
  enterpriseProviderId,
} from "./enterprise-sync";

const BINDING = { serverUrl: "http://localhost:3100", deviceToken: "wbd_test_token" };

function baseConfig(): Record<string, any> {
  return {
    providers: {
      "custom:my-own": {
        name: "我自己的",
        base_url: "http://localhost:3000/v1",
        api_key: "sk-mine",
        model: "my-model",
        models: { "my-model": {} },
      },
      [enterpriseProviderId("old-model")]: {
        name: "old-model",
        base_url: "http://localhost:3100/api/workbuddy/proxy/v1",
        api_key: "wbd_test_token",
        model: "old-model",
        models: { "old-model": {} },
      },
    },
    model: { provider: "custom:my-own", default: "my-model" },
  };
}

describe("applyEnterpriseSync", () => {
  it("upserts manifest models as team providers and drops stale ones", () => {
    const next = applyEnterpriseSync(baseConfig(), BINDING, {
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT 5.6 SOL",
          supportsToolCall: true,
          supportsImages: true,
          maxInputTokens: 131072,
        },
      ],
    });
    const providers = next.providers as Record<string, any>;
    // 旧的 team provider 被移除，新的写入
    expect(providers[enterpriseProviderId("old-model")]).toBeUndefined();
    const written = providers[enterpriseProviderId("gpt-5.6-sol")];
    expect(written.base_url).toBe("http://localhost:3100/api/workbuddy/proxy/v1");
    expect(written.api_key).toBe("wbd_test_token");
    expect(written.api_mode).toBe("chat_completions");
    expect(written.models["gpt-5.6-sol"]).toMatchObject({
      context_length: 131072,
      supports_tools: true,
      supports_vision: true,
      supports_reasoning: false,
    });
    // 非 team 前缀的自定义 provider 不受影响
    expect(providers["custom:my-own"]).toBeDefined();
  });

  it("honors per-model url override and writes default model when present", () => {
    const next = applyEnterpriseSync(baseConfig(), BINDING, {
      models: [{ id: "kimi-k3", url: "http://localhost:3100/api/workbuddy/proxy/v1" }],
      defaultModel: "kimi-k3",
    });
    const model = next.model as Record<string, any>;
    expect(model.provider).toBe(enterpriseProviderId("kimi-k3"));
    expect(model.default).toBe("kimi-k3");
    expect(model.api_key).toBe("wbd_test_token");
  });

  it("ignores defaultModel that is not in the manifest", () => {
    const next = applyEnterpriseSync(baseConfig(), BINDING, {
      models: [{ id: "kimi-k3" }],
      defaultModel: "not-in-manifest",
    });
    const model = next.model as Record<string, any>;
    expect(model.provider).toBe("custom:my-own");
    expect(model.default).toBe("my-model");
  });

  it("cleanupOnly removes all team providers and keeps others", () => {
    const next = applyEnterpriseSync(baseConfig(), BINDING, { cleanupOnly: true });
    const providers = next.providers as Record<string, any>;
    expect(Object.keys(providers).some((key) => key.startsWith(ENTERPRISE_PROVIDER_PREFIX))).toBe(false);
    expect(providers["custom:my-own"]).toBeDefined();
  });

  it("skips manifest entries without an id", () => {
    const next = applyEnterpriseSync(baseConfig(), BINDING, {
      models: [{ name: "no-id" } as any, { id: "ok-model" }],
    });
    const providers = next.providers as Record<string, any>;
    expect(Object.keys(providers).filter((key) => key.startsWith(ENTERPRISE_PROVIDER_PREFIX))).toEqual([
      enterpriseProviderId("ok-model"),
    ]);
  });
});
