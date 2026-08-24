import { describe, expect, it } from "vitest";
import {
  AmbiguousAliasError,
  BUILTIN_MODEL_ALIASES,
  canonicalAliasForm,
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

describe("canonicalAliasForm", () => {
  it("formats provider/model pairs", () => {
    expect(canonicalAliasForm({ provider: "openai", model: "gpt-4o" })).toBe("openai/gpt-4o");
  });

  it("includes an empty provider when none is set", () => {
    // `provider` is typed as required; when a caller omits it the template
    // literal coerces undefined — assert the actual runtime behavior.
    expect(
      canonicalAliasForm({ model: "custom" } as unknown as Parameters<typeof canonicalAliasForm>[0]),
    ).toBe("undefined/custom");
    expect(canonicalAliasForm({ provider: "", model: "custom" })).toBe("/custom");
  });
});

describe("AmbiguousAliasError", () => {
  it("exposes alias, matches, and an informative message", () => {
    const error = new AmbiguousAliasError("sonnet", [
      "anthropic/claude-sonnet",
      "openai/gpt-4o",
    ]);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AmbiguousAliasError");
    expect(error.alias).toBe("sonnet");
    expect(error.matches).toEqual(["anthropic/claude-sonnet", "openai/gpt-4o"]);
    expect(error.message).toContain("sonnet");
    expect(error.message).toContain("anthropic/claude-sonnet");
  });

  it("handles empty matches", () => {
    const error = new AmbiguousAliasError("x", []);
    expect(error.matches).toEqual([]);
    expect(error.message).toBe('Alias "x" is ambiguous: ');
  });
});
