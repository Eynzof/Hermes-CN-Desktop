import { describe, expect, it } from "vitest";
import { selectProviderModelIds } from "./use-provider-models";

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
