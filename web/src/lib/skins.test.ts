import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_SKIN_SLUGS,
  DEFAULT_SKIN_PRESET,
  applySkin,
  getSkinBySlug,
  injectSkinStyles,
  isSkinSlug,
  listSkins,
  loadSkin,
  parseSkinSource,
  skinTokenToCssVar,
} from "./skins";

describe("skin registry", () => {
  it("ships 14 built-in skins", () => {
    expect(BUILTIN_SKIN_SLUGS.length).toBe(14);
    expect(listSkins().length).toBe(14);
  });

  it("has unique slugs and names", () => {
    const slugs = new Set<string>();
    const names = new Set<string>();
    for (const skin of listSkins()) {
      expect(slugs.has(skin.slug)).toBe(false);
      expect(names.has(skin.name)).toBe(false);
      slugs.add(skin.slug);
      names.add(skin.name);
    }
  });

  it("includes the requested core skins", () => {
    const slugs = new Set(BUILTIN_SKIN_SLUGS);
    for (const expected of [
      "default",
      "dark",
      "light",
      "high-contrast",
      "midnight",
      "ocean",
      "forest",
      "ares",
      "mono",
      "slate",
      "daylight",
      "warm-lightmode",
      "poseidon",
      "sisyphus",
    ] as const) {
      expect(slugs.has(expected as import("@hermes/shared-ui").SkinSlug)).toBe(true);
    }
  });

  it("falls back to default for unknown slugs", () => {
    expect(getSkinBySlug("unknown" as any).slug).toBe("default");
  });

  it("loads built-ins by slug", () => {
    expect(loadSkin("ares").slug).toBe("ares");
    expect(loadSkin("unknown").slug).toBe("default");
  });

  it("validates skin slugs", () => {
    expect(isSkinSlug("default")).toBe(true);
    expect(isSkinSlug("ares")).toBe(true);
    expect(isSkinSlug("charizard")).toBe(false);
    expect(isSkinSlug("")).toBe(false);
  });

  it("exposes default skin token overrides", () => {
    expect(DEFAULT_SKIN_PRESET.tokenOverrides.accent).toBe("#ff7a3d");
    expect(DEFAULT_SKIN_PRESET.branding.agentName).toBe("Hermes");
  });
});

describe("skin parser", () => {
  it("parses JSON skin definitions", () => {
    const src = JSON.stringify({
      name: "Custom",
      description: "A test skin",
      polarity: "dark",
      colors: {
        accent: "#a93333",
        accent_soft: "#f5d0d0",
        invalid_key: "nope",
      },
      branding: {
        agent_name: "Tester",
        response_label: "Test",
      },
      tool_emojis: {
        execute_code: "💻",
      },
    });
    const def = parseSkinSource(src);
    expect(def.name).toBe("Custom");
    expect(def.polarity).toBe("dark");
    expect(def.colors?.accent).toBe("#a93333");
    expect(def.colors?.accent_soft).toBe("#f5d0d0");
    expect(def.colors?.invalid_key).toBeUndefined();
    expect(def.branding?.agentName).toBe("Tester");
    expect(def.tool_emojis?.execute_code).toBe("💻");
  });

  it("parses YAML skin definitions", () => {
    const src = `
name: Ocean YAML
description: Parsed from YAML
polarity: light
colors:
  accent: "#00a8b5"
  accent_soft: "#e0f7fa"
  status_ok: "#2ecc71"
spinner:
  waiting_faces:
    - "◐"
    - "◓"
  thinking_verbs:
    - flowing
    - drifting
branding:
  agent_name: Neptune
tool_emojis:
  web_search: "🌊"
`;
    const def = parseSkinSource(src);
    expect(def.name).toBe("Ocean YAML");
    expect(def.polarity).toBe("light");
    expect(def.colors?.accent).toBe("#00a8b5");
    expect(def.spinner?.waitingFaces).toEqual(["◐", "◓"]);
    expect(def.spinner?.thinkingVerbs).toEqual(["flowing", "drifting"]);
    expect(def.branding?.agentName).toBe("Neptune");
    expect(def.tool_emojis?.web_search).toBe("🌊");
  });

  it("rejects malformed JSON", () => {
    expect(() => parseSkinSource("{not json")).toThrow(/Invalid JSON/);
  });

  it("normalizes 3-digit hex values", () => {
    const def = parseSkinSource(JSON.stringify({ colors: { accent: "#abc" } }));
    expect(def.colors?.accent).toBe("#aabbcc");
  });

  it("drops non-hex colour values", () => {
    const def = parseSkinSource(JSON.stringify({ colors: { accent: "not-a-color" } }));
    expect(def.colors?.accent).toBeUndefined();
  });

  it("throws on empty source", () => {
    expect(() => parseSkinSource("   ")).toThrow(/Empty skin source/);
  });
});

describe("skin CSS injection", () => {
  it("maps token overrides to CSS custom properties", () => {
    const css = injectSkinStyles(DEFAULT_SKIN_PRESET);
    expect(css).toContain(`[data-skin="default"]`);
    expect(css).toContain(`${skinTokenToCssVar("accent")}: #ff7a3d;`);
    expect(css).toContain(`${skinTokenToCssVar("accentSoft")}: rgba(255, 122, 61, 0.12);`);
  });

  it("produces a valid CSS block for every built-in skin", () => {
    for (const skin of listSkins()) {
      const css = injectSkinStyles(skin);
      expect(css).toContain(`[data-skin="${skin.slug}"]`);
      expect(css).toContain("--h-skin-");
    }
  });
});

describe("applySkin DOM", () => {
  const attrs = new Map<string, string>();
  const root = {
    setAttribute: (key: string, value: string) => attrs.set(key, value),
    getAttribute: (key: string) => attrs.get(key) ?? null,
    style: {},
  };

  beforeEach(() => {
    attrs.clear();
    (globalThis as { document?: unknown }).document = { documentElement: root };
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it("sets data-skin to the requested slug", () => {
    applySkin("ares");
    expect(attrs.get("data-skin")).toBe("ares");
  });

  it("falls back to default for unknown slugs", () => {
    applySkin("charizard");
    expect(attrs.get("data-skin")).toBe("default");
  });
});
