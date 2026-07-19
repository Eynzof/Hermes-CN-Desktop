import { describe, expect, it } from "vitest";
import { flattenModelChoices } from "./profile-model-select";
import { modelChoiceKey } from "./profile-model-key";

describe("flattenModelChoices", () => {
  it("摊平 providers[].models 为带 label 的选项", () => {
    const choices = flattenModelChoices([
      { slug: "deepseek", name: "DeepSeek", models: ["deepseek-v4-flash", "deepseek-v4-pro"] },
    ]);

    expect(choices).toEqual([
      {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        label: "DeepSeek · deepseek-v4-flash",
        key: modelChoiceKey("deepseek", "deepseek-v4-flash"),
      },
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        label: "DeepSeek · deepseek-v4-pro",
        key: modelChoiceKey("deepseek", "deepseek-v4-pro"),
      },
    ]);
  });

  it("去掉同一 provider 内重复的 model，避免重复 key", () => {
    const choices = flattenModelChoices([
      { slug: "deepseek", name: "DeepSeek", models: ["deepseek-v4-flash", "deepseek-v4-flash"] },
    ]);

    const keys = choices.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(choices.map((c) => c.model)).toEqual(["deepseek-v4-flash"]);
  });

  it("去掉网关重复返回的 provider，避免重复 key", () => {
    const choices = flattenModelChoices([
      { slug: "deepseek", name: "DeepSeek", models: ["deepseek-v4-flash"] },
      { slug: "deepseek", name: "DeepSeek", models: ["deepseek-v4-flash"] },
    ]);

    expect(choices).toHaveLength(1);
  });

  it("不同 provider 的同名 model 各自保留（key 含 provider 不冲突）", () => {
    const choices = flattenModelChoices([
      { slug: "deepseek", name: "DeepSeek", models: ["deepseek-v4-flash"] },
      { slug: "modelverse", name: "优云智算", models: ["deepseek-v4-flash"] },
    ]);

    expect(choices).toHaveLength(2);
    expect(new Set(choices.map((c) => c.key)).size).toBe(2);
  });

  it("name 缺失时 label 回退到 slug", () => {
    const choices = flattenModelChoices([{ slug: "custom", models: ["m1"] }]);

    expect(choices[0]?.label).toBe("custom · m1");
  });

  it("providers 为 undefined 时返回空数组", () => {
    expect(flattenModelChoices(undefined)).toEqual([]);
  });
});
