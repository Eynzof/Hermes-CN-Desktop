import { describe, expect, it } from "vitest";
import type { EnvVarInfo } from "@hermes/protocol";
import { translateEnvCategory, translateEnvVar } from "./env-translations";

function envInfo(description: string, category = "tool"): EnvVarInfo {
  return {
    is_set: false,
    redacted_value: null,
    description,
    url: null,
    category,
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
    expect(translateEnvVar("WEIXIN_TOKEN", envInfo("Weixin token")).description).toContain("微信接入");
  });

  it("returns Chinese labels for plugin-provided messaging keys", () => {
    expect(translateEnvVar("DISCORD_ALLOW_ALL_USERS", envInfo("Allow any Discord user")).label).toBe(
      "Discord 允许所有用户",
    );
    expect(translateEnvVar("GOOGLE_CHAT_PROJECT_ID", envInfo("GCP project ID")).description).toContain(
      "Pub/Sub",
    );
    expect(translateEnvVar("IRC_PORT", envInfo("IRC server port")).label).toBe("IRC 端口");
  });

  it("returns Chinese labels for ntfy platform env vars", () => {
    expect(translateEnvVar("NTFY_TOPIC", envInfo("Topic name to subscribe to")).label).toBe("ntfy 订阅主题");
    expect(translateEnvVar("NTFY_TOKEN", envInfo("Bearer token")).description).toContain("Basic auth");
    expect(translateEnvVar("NTFY_ALLOW_ALL_USERS", envInfo("Allow any topic")).label).toBe("ntfy 允许所有主题");
  });

  it("builds Chinese display text for advanced provider env vars", () => {
    expect(translateEnvVar("NOUS_BASE_URL", envInfo("Nous Portal base URL override", "provider"))).toEqual({
      label: "Nous Portal Base URL",
      description: "Nous Portal API Base URL 覆盖；留空时使用默认端点。",
    });
    expect(translateEnvVar("OPENROUTER_API_KEY", envInfo("OpenRouter API key", "provider")).description).toBe(
      "OpenRouter API Key，用于访问该模型服务商。",
    );
    expect(translateEnvVar("HERMES_GEMINI_CLIENT_SECRET", envInfo("Google OAuth client secret", "provider")).label).toBe(
      "Gemini OAuth Client Secret",
    );
  });

  it("uses a provider fallback instead of backend English for unknown provider keys", () => {
    expect(translateEnvVar("NEWCO_API_KEY", envInfo("New provider API key", "provider"))).toEqual({
      label: "Newco API Key",
      description: "Newco API Key，用于访问该模型服务商。",
    });
    expect(translateEnvVar("SOME_PROVIDER_CUSTOM_FLAG", envInfo("Some English text", "provider")).description).toBe(
      "模型服务商相关高级环境变量。原始变量名：SOME_PROVIDER_CUSTOM_FLAG。",
    );
  });

  it("falls back to backend-provided metadata for unknown keys", () => {
    const translated = translateEnvVar("SOME_NEW_ENV", envInfo("Backend English description"));
    expect(translated).toEqual({
      label: "SOME_NEW_ENV",
      description: "Backend English description",
    });
  });
});
