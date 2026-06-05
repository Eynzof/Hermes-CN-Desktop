import { describe, expect, it } from "vitest";
import type { EnvVarInfo } from "@hermes/protocol";
import { translateEnvCategory, translateEnvVar } from "./env-translations";

function envInfo(description: string): EnvVarInfo {
  return {
    is_set: false,
    redacted_value: null,
    description,
    url: null,
    category: "tool",
    is_password: true,
    tools: [],
    advanced: false,
  };
}

describe("translateEnvCategory", () => {
  it("translates known env categories", () => {
    expect(translateEnvCategory("tool")).toBe("工具密钥");
    expect(translateEnvCategory("messaging")).toBe("消息平台");
  });

  it("falls back to the raw category for unknown values", () => {
    expect(translateEnvCategory("custom")).toBe("custom");
  });
});

describe("translateEnvVar", () => {
  it("returns Chinese labels and descriptions for tool keys", () => {
    expect(translateEnvVar("EXA_API_KEY", envInfo("Exa API key")).label).toBe("Exa 搜索 API Key");
    expect(translateEnvVar("BROWSERBASE_PROJECT_ID", envInfo("Browserbase project ID")).description).toContain("云浏览器");
  });

  it("returns Chinese labels and descriptions for Feishu and Weixin keys", () => {
    expect(translateEnvVar("FEISHU_APP_SECRET", envInfo("Feishu secret")).label).toBe("飞书 App Secret");
    expect(translateEnvVar("WEIXIN_TOKEN", envInfo("Weixin token")).description).toContain("iLink bot");
  });

  it("falls back to backend-provided metadata for unknown keys", () => {
    const translated = translateEnvVar("SOME_NEW_ENV", envInfo("Backend English description"));
    expect(translated).toEqual({
      label: "SOME_NEW_ENV",
      description: "Backend English description",
    });
  });
});
