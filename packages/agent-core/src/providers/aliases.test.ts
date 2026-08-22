import { describe, expect, it } from "vitest";
import {
  BUILTIN_MODEL_ALIASES,
  loadDirectAliases,
  resolveAlias,
} from "./aliases.js";

describe("alias resolution", () => {
  it("resolves built-in aliases", () => {
    expect(resolveAlias("claude-opus")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-20250514",
    });
    expect(resolveAlias("sonnet")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });
  });

  it("resolves provider/model form when provider is supplied", () => {
    expect(resolveAlias("openai/gpt-4o", "openai")).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("splits provider:model form", () => {
    expect(resolveAlias("google:gemini-2.5-pro")).toEqual({
      provider: "google",
      model: "gemini-2.5-pro",
    });
  });

  it("falls back to raw model id", () => {
    expect(resolveAlias("some-custom-model")).toEqual({
      provider: "",
      model: "some-custom-model",
    });
  });

  it("loads full-form user aliases", () => {
    const cfg = {
      model_aliases: {
        mymodel: { provider: "openai", model: "gpt-4o-mini" },
      },
    };
    expect(resolveAlias("mymodel", undefined, cfg)).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("loads short-form user aliases", () => {
    const cfg = {
      model: {
        aliases: {
          fast: "openai/gpt-4o-mini",
        },
      },
    };
    expect(resolveAlias("fast", undefined, cfg)).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("user aliases shadow built-ins", () => {
    const cfg = {
      model: {
        aliases: {
          sonnet: "openai/gpt-4o",
        },
      },
    };
    expect(resolveAlias("sonnet", undefined, cfg)).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("loadDirectAliases merges both forms", () => {
    const cfg = {
      model_aliases: { a: "openai/gpt-4" },
      model: { aliases: { b: "anthropic/claude" } },
    };
    const map = loadDirectAliases(cfg);
    expect(map.get("a")).toEqual({ provider: "openai", model: "gpt-4" });
    expect(map.get("b")).toEqual({ provider: "anthropic", model: "claude" });
  });

  it("ignores malformed entries", () => {
    const cfg = {
      model_aliases: {
        bad: { notamodel: true },
      },
    };
    // @ts-expect-error malformed runtime input used to verify defensive parsing
    expect(loadDirectAliases(cfg).has("bad")).toBe(false);
  });

  it("BUILTIN_MODEL_ALIASES covers core aliases", () => {
    for (const key of [
      "claude-opus",
      "sonnet",
      "haiku",
      "kimi",
      "qwen",
      "glm",
      "gpt4",
      "gpt4o",
      "gemini",
      "deepseek",
    ]) {
      expect(BUILTIN_MODEL_ALIASES[key]).toBeDefined();
      expect(BUILTIN_MODEL_ALIASES[key].provider).toBeTruthy();
      expect(BUILTIN_MODEL_ALIASES[key].model).toBeTruthy();
    }
  });
});
