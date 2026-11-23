import { describe, expect, it } from "vitest";
import { codingPlanModelOptions, providerModelsErrorText, selectProviderModelIds } from "./use-provider-models";

describe("selectProviderModelIds", () => {
  it("sorts and de-dupes the returned ids", () => {
    const ids = selectProviderModelIds({
      ok: true,
      models: ["qwen2.5-coder:7b", "llama3", "qwen2.5-coder:7b"],
      model_count: 3,
      status_code: 200,
      error: null,
      error_kind: null,
    });
    expect(ids).toEqual(["llama3", "qwen2.5-coder:7b"]);
  });

  it("drops empty ids", () => {
    const ids = selectProviderModelIds({
      ok: true,
      models: ["", "a", ""],
      model_count: 3,
      status_code: 200,
      error: null,
      error_kind: null,
    });
    expect(ids).toEqual(["a"]);
  });

  it("throws the backend error when the probe failed", () => {
    expect(() =>
      selectProviderModelIds({
        ok: false,
        models: [],
        model_count: 0,
        status_code: 401,
        error: "API key rejected (HTTP 401)",
        error_kind: "auth",
      }),
    ).toThrow("API key rejected (HTTP 401)");
  });

  it("falls back to a generic message when ok is false with no error text", () => {
    expect(() =>
      selectProviderModelIds({
        ok: false,
        models: [],
        model_count: 0,
        status_code: null,
        error: null,
        error_kind: null,
      }),
    ).toThrow("模型列表获取失败");
  });
});

describe("providerModelsErrorText", () => {
  it("translates common model discovery failures", () => {
    expect(providerModelsErrorText(new Error("HTTP 404 Not Found"))).toBe(
      "此服务商未提供 /models 端点",
    );
    expect(providerModelsErrorText(new Error("API key rejected (HTTP 401)"))).toBe(
      "API Key 无效或未保存",
    );
  });

  it("keeps an unknown backend error intact", () => {
    expect(providerModelsErrorText(new Error("upstream unavailable"))).toBe("upstream unavailable");
  });
});

describe("Coding Plan settings model options", () => {
  const preset = ["glm-5.3", "glm-5.1"];
  it("uses the account list, retaining the saved and edited values once", () => {
    expect(codingPlanModelOptions(preset, ["glm-5.3-flashx"], "saved", "glm-5.3-flashx"))
      .toEqual(["glm-5.3-flashx", "saved"]);
  });

  it("uses the preset before discovery or on error and preserves an empty live response", () => {
    expect(codingPlanModelOptions(preset, undefined, "saved", "")).toEqual([...preset, "saved"]);
    expect(codingPlanModelOptions(preset, [], "saved", "saved")).toEqual(["saved"]);
  });
});
