import { describe, expect, it } from "vitest";
import { CN_ENV_VAR_METADATA, envKeyToProvider, type EnvVarMeta } from "./env-vars";

describe("CN_ENV_VAR_METADATA", () => {
  it("has the nine CN provider entries", () => {
    expect(Object.keys(CN_ENV_VAR_METADATA).sort()).toEqual([
      "AI302_API_KEY",
      "ARK_API_KEY",
      "ARK_BASE_URL",
      "COMPSHARE_API_KEY",
      "HUNYUAN_API_KEY",
      "LONGCAT_API_KEY",
      "MODELSCOPE_API_KEY",
      "QIANFAN_API_KEY",
      "SILICONFLOW_API_KEY",
    ]);
  });

  it("keys every record by its own env var key", () => {
    for (const [key, meta] of Object.entries(CN_ENV_VAR_METADATA)) {
      expect(meta.key).toBe(key);
    }
  });

  it("describes provider API keys as passwords with docs urls", () => {
    const keyEntries = Object.values(CN_ENV_VAR_METADATA).filter((m) => m.key.endsWith("_API_KEY"));
    for (const meta of keyEntries) {
      expect(meta.password).toBe(true);
      expect(meta.category).toBe("provider");
      expect(meta.advanced).toBe(true);
      expect(meta.url).toBeTruthy();
      expect(meta.description.length).toBeGreaterThan(0);
      expect(meta.prompt.length).toBeGreaterThan(0);
      expect(meta.tools).toEqual([]);
    }
  });

  it("marks the ARK base URL override as a non-secret provider setting", () => {
    const baseUrl = CN_ENV_VAR_METADATA.ARK_BASE_URL as EnvVarMeta;
    expect(baseUrl).toBeDefined();
    expect(baseUrl.password).toBe(false);
    expect(baseUrl.url).toBeNull();
    expect(baseUrl.category).toBe("provider");
    expect(baseUrl.description).toContain("https://ark.cn-beijing.volces.com/api/v3");
  });

  it("keeps every entry structurally valid", () => {
    const validCategories: EnvVarMeta["category"][] = [
      "provider",
      "tool",
      "messaging",
      "setting",
      "service",
    ];
    for (const meta of Object.values(CN_ENV_VAR_METADATA)) {
      expect(typeof meta.key).toBe("string");
      expect(typeof meta.description).toBe("string");
      expect(typeof meta.prompt).toBe("string");
      expect(meta.url === null || typeof meta.url === "string").toBe(true);
      expect(typeof meta.password).toBe("boolean");
      expect(validCategories).toContain(meta.category);
      expect(typeof meta.advanced).toBe("boolean");
      expect(Array.isArray(meta.tools)).toBe(true);
    }
  });
});

describe("envKeyToProvider", () => {
  it("maps each CN provider key to its provider slug", () => {
    expect(envKeyToProvider("ARK_API_KEY")).toBe("volcengine-ark");
    expect(envKeyToProvider("ARK_BASE_URL")).toBe("volcengine-ark");
    expect(envKeyToProvider("QIANFAN_API_KEY")).toBe("qianfan");
    expect(envKeyToProvider("HUNYUAN_API_KEY")).toBe("hunyuan");
    expect(envKeyToProvider("SILICONFLOW_API_KEY")).toBe("siliconflow");
    expect(envKeyToProvider("MODELSCOPE_API_KEY")).toBe("modelscope");
    expect(envKeyToProvider("COMPSHARE_API_KEY")).toBe("compshare");
    expect(envKeyToProvider("AI302_API_KEY")).toBe("ai302");
    expect(envKeyToProvider("LONGCAT_API_KEY")).toBe("longcat");
  });

  it("covers every metadata key so the UI can group by provider", () => {
    for (const key of Object.keys(CN_ENV_VAR_METADATA)) {
      expect(envKeyToProvider(key), `missing provider mapping for ${key}`).toBeDefined();
    }
  });

  it("returns undefined for unknown keys", () => {
    expect(envKeyToProvider("OPENAI_API_KEY")).toBeUndefined();
    expect(envKeyToProvider("")).toBeUndefined();
    expect(envKeyToProvider("ark_api_key")).toBeUndefined(); // case sensitive by design
  });
});
