import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROVIDER_CATALOG,
  buildProviderConfigUpdate,
  buildProviderSettingsUpdate,
  shouldPromoteProviderOnSave,
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
