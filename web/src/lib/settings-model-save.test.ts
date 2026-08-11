import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROVIDER_CATALOG,
  buildProviderConfigUpdate,
  buildProviderSettingsUpdate,
  shouldPromoteProviderOnSave,
  shouldUpdateDefaultModelOnSave,
} from "./provider-catalog";

describe("shouldPromoteProviderOnSave", () => {
  it("promotes when /api/model/info has no model at all (first-run)", () => {
    expect(shouldPromoteProviderOnSave({ model: "", provider: "" })).toBe(true);
    expect(shouldPromoteProviderOnSave({ model: "  ", provider: "" })).toBe(true);
    expect(shouldPromoteProviderOnSave({ model: "", provider: undefined })).toBe(true);
  });

  it("promotes when the runtime has a model but no provider", () => {
    expect(shouldPromoteProviderOnSave({ model: "claude-opus-4-8", provider: "" })).toBe(true);
  });

  it("does NOT promote when a default model already exists", () => {
    expect(shouldPromoteProviderOnSave({ model: "deepseek-v4-flash", provider: "deepseek" })).toBe(false);
  });

  it("stays conservative while model info is still loading", () => {
    expect(shouldPromoteProviderOnSave(undefined)).toBe(false);
    expect(shouldPromoteProviderOnSave(null)).toBe(false);
  });
});

describe("save path semantics for the workbench default model", () => {
  const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "kimi-for-coding");
  expect(preset).toBeTruthy();

  const input = {
    apiKey: "kimi-key",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2.6",
  };

  it("保存配置（已有默认模型）只写 providers.<id>，不动 model.*", () => {
    const config = buildProviderSettingsUpdate(
      { model: { provider: "deepseek", default: "deepseek-v4-flash" } },
      preset!,
      input,
    );
    expect(config.providers["kimi-for-coding"]).toMatchObject({
      api_key: "kimi-key",
      model: "kimi-k2.6",
    });
    expect(config.model).toEqual({ provider: "deepseek", default: "deepseek-v4-flash" });
  });

  it("首次保存（无默认模型）用 buildProviderConfigUpdate 写入 model.*（provider + default）", () => {
    const config = buildProviderConfigUpdate({}, preset!, input);
    expect(config.providers["kimi-for-coding"]).toMatchObject({
      api_key: "kimi-key",
      model: "kimi-k2.6",
    });
    expect(config.model).toMatchObject({
      provider: "kimi-for-coding",
      default: "kimi-k2.6",
      base_url: "https://api.moonshot.cn/v1",
      api_mode: "chat_completions",
      api_key: "kimi-key",
    });
  });
});

describe("shouldUpdateDefaultModelOnSave（编辑当前默认主模型后保存）", () => {
  it("编辑当前默认主模型的服务商（改模型后保存）仍应保持为默认", () => {
    expect(
      shouldUpdateDefaultModelOnSave({
        currentProviderId: "deepseek",
        selectedProviderId: "deepseek",
        modelInfo: { model: "deepseek-v4-flash", provider: "deepseek" },
      }),
    ).toBe(true);
  });

  it("编辑非默认服务商时不改动默认主模型", () => {
    expect(
      shouldUpdateDefaultModelOnSave({
        currentProviderId: "deepseek",
        selectedProviderId: "kimi-for-coding",
        modelInfo: { model: "deepseek-v4-flash", provider: "deepseek" },
      }),
    ).toBe(false);
  });

  it("首次运行没有默认模型时提升为默认", () => {
    expect(
      shouldUpdateDefaultModelOnSave({
        currentProviderId: "",
        selectedProviderId: "deepseek",
        modelInfo: { model: "", provider: "" },
      }),
    ).toBe(true);
  });

  it("modelInfo 未加载且无当前 provider 可匹配时保守不更新", () => {
    expect(
      shouldUpdateDefaultModelOnSave({
        currentProviderId: "",
        selectedProviderId: "deepseek",
        modelInfo: undefined,
      }),
    ).toBe(false);
  });

  // 回归：这正是“改完当前默认服务商点保存配置后，已是当前模型变成设为当前
  // 模型”的根因——保存决策只写 providers.<id>，导致 config.model 与
  // providers.<id> 脱节。决策为 true 时保存必须写 model.*，默认主模型跟着更新。
  it("编辑当前默认服务商改模型后保存：默认主模型必须跟随更新", () => {
    const currentDefault = { provider: "deepseek", default: "deepseek-v4-flash" };
    const deepseek = BUILTIN_PROVIDER_CATALOG.providers.find((p) => p.id === "deepseek")!;
    expect(deepseek).toBeTruthy();

    // 用户在 deepseek 卡片上把模型从 flash 改成 pro，然后点「保存配置」。
    const form = {
      apiKey: "",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      contextWindow: "",
    };
    const shouldUpdate = shouldUpdateDefaultModelOnSave({
      currentProviderId: currentDefault.provider,
      selectedProviderId: deepseek.id,
      modelInfo: { model: currentDefault.default, provider: currentDefault.provider },
    });
    expect(shouldUpdate).toBe(true);

    const saved = shouldUpdate
      ? buildProviderConfigUpdate({ model: currentDefault }, deepseek, form)
      : buildProviderSettingsUpdate({ model: currentDefault }, deepseek, form);

    expect(saved.providers["deepseek"]).toMatchObject({ model: "deepseek-v4-pro" });
    // 默认主模型必须还是 deepseek，且 default 跟着改成新模型——否则按钮翻回
    // 「设为当前模型」，工作台默认模型仍是旧模型。
    expect(saved.model).toMatchObject({
      provider: "deepseek",
      default: "deepseek-v4-pro",
    });
  });
});
