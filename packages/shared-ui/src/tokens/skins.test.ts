import { describe, expect, it } from "vitest";
import {
  BUILTIN_SKINS,
  BUILTIN_SKIN_SLUGS,
  DEFAULT_SKIN_PRESET,
  SkinValidationError,
  buildSkinPreset,
  getSkinBySlug,
  isSkinSlug,
  listSkinSlugs,
  listSkins,
  loadSkinFromSource,
  parseSkinSource,
  skinTokenToCssVar,
  validateSkinDefinition,
  type SkinPreset,
  type SkinSlug,
  type SkinToken,
} from "./skins";

const ALL_TOKENS: SkinToken[] = [
  "accent",
  "accentSoft",
  "accentBorder",
  "accentContrast",
  "statusOk",
  "statusWarn",
  "statusDanger",
  "codeBg",
  "diffAdded",
  "diffRemoved",
];

describe("built-in skin registry", () => {
  it("exposes the 14 documented built-in skins", () => {
    expect(Object.keys(BUILTIN_SKINS).sort()).toEqual(
      [
        "ares",
        "dark",
        "daylight",
        "default",
        "forest",
        "high-contrast",
        "light",
        "midnight",
        "mono",
        "ocean",
        "poseidon",
        "sisyphus",
        "slate",
        "warm-lightmode",
      ].sort(),
    );
  });

  it("every preset is well-formed", () => {
    for (const [slug, preset] of Object.entries(BUILTIN_SKINS)) {
      expect(preset.slug).toBe(slug);
      expect(preset.name).toBeTruthy();
      expect(preset.description).toBeTruthy();
      expect(preset.source).toBe("builtin");
      expect(["dark", "light"]).toContain(preset.polarity);
      expect(preset.branding.agentName).toBeTruthy();
      expect(preset.branding.responseLabel).toBeTruthy();
      expect(Array.isArray(preset.spinner.waitingFaces)).toBe(true);
      expect(preset.spinner.waitingFaces.length).toBeGreaterThan(0);
      expect(Array.isArray(preset.spinner.thinkingFaces)).toBe(true);
      expect(preset.spinner.thinkingFaces.length).toBeGreaterThan(0);
      expect(Array.isArray(preset.spinner.thinkingVerbs)).toBe(true);
      expect(preset.spinner.thinkingVerbs.length).toBeGreaterThan(0);
      expect(Array.isArray(preset.spinner.wings)).toBe(true);
      for (const wing of preset.spinner.wings) {
        expect(Array.isArray(wing)).toBe(true);
        expect(wing).toHaveLength(2);
      }
      expect(typeof preset.toolEmojis).toBe("object");
      expect(preset.tokenOverrides.accent).toBeTruthy();
    }
  });

  it("presets have unique slugs", () => {
    const slugs = Object.keys(BUILTIN_SKINS);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("listSkinSlugs is frozen and matches the registry", () => {
    expect(Object.isFrozen(BUILTIN_SKIN_SLUGS)).toBe(true);
    expect(listSkinSlugs()).toEqual(BUILTIN_SKIN_SLUGS);
    expect([...listSkinSlugs()]).toEqual(Object.keys(BUILTIN_SKINS));
  });

  it("listSkins returns one preset per slug in registry order", () => {
    const skins = listSkins();
    expect(skins).toHaveLength(BUILTIN_SKIN_SLUGS.length);
    expect(skins.map((s) => s.slug)).toEqual([...BUILTIN_SKIN_SLUGS]);
  });

  it("getSkinBySlug returns the matching preset", () => {
    expect(getSkinBySlug("ares")).toBe(BUILTIN_SKINS.ares);
    expect(getSkinBySlug("default")).toBe(DEFAULT_SKIN_PRESET);
  });

  it("getSkinBySlug falls back to default for unknown slugs", () => {
    expect(getSkinBySlug("charizard" as SkinSlug)).toBe(DEFAULT_SKIN_PRESET);
    expect(getSkinBySlug("" as SkinSlug)).toBe(DEFAULT_SKIN_PRESET);
  });

  it("isSkinSlug distinguishes valid slugs", () => {
    for (const slug of BUILTIN_SKIN_SLUGS) {
      expect(isSkinSlug(slug)).toBe(true);
    }
    expect(isSkinSlug("charizard")).toBe(false);
    expect(isSkinSlug("DEFAULT")).toBe(false);
    expect(isSkinSlug("")).toBe(false);
    expect(isSkinSlug(42)).toBe(false);
    expect(isSkinSlug(null)).toBe(false);
    expect(isSkinSlug(undefined)).toBe(false);
  });

  it("parity: golden values match the CLI skin-engine palette", () => {
    expect(DEFAULT_SKIN_PRESET.tokenOverrides.accent).toBe("#ff7a3d");
    expect(BUILTIN_SKINS.ares.tokenOverrides.accent).toBe("#a93333");
    expect(BUILTIN_SKINS.slate.tokenOverrides.accent).toBe("#7eb8f6");
    expect(BUILTIN_SKINS.ares.bannerLogo).toBe("[bold #A93333]Ares[/]");
    expect(BUILTIN_SKINS.ares.branding.agentName).toBe("Ares");
    expect(BUILTIN_SKINS.ares.toolEmojis.execute_code).toBe("💻");
    expect(BUILTIN_SKINS.poseidon.toolEmojis.web_search).toBe("🌊");
    expect(BUILTIN_SKINS.sisyphus.branding.promptSymbol).toBe("🪨");
    expect(BUILTIN_SKINS.daylight.polarity).toBe("light");
    expect(BUILTIN_SKINS["warm-lightmode"].polarity).toBe("light");
  });

  it("default preset carries the full semantic token set", () => {
    for (const token of ALL_TOKENS) {
      expect(DEFAULT_SKIN_PRESET.tokenOverrides[token]).toBeTruthy();
    }
  });
});

describe("skinTokenToCssVar", () => {
  it("maps every token to its CSS custom property", () => {
    const expected: Record<SkinToken, string> = {
      accent: "--h-skin-accent",
      accentSoft: "--h-skin-accent-soft",
      accentBorder: "--h-skin-accent-border",
      accentContrast: "--h-skin-accent-contrast",
      statusOk: "--h-skin-status-ok",
      statusWarn: "--h-skin-status-warn",
      statusDanger: "--h-skin-status-danger",
      codeBg: "--h-skin-code-bg",
      diffAdded: "--h-skin-diff-added",
      diffRemoved: "--h-skin-diff-removed",
    };
    for (const token of ALL_TOKENS) {
      expect(skinTokenToCssVar(token)).toBe(expected[token]);
    }
  });
});

describe("validateSkinDefinition", () => {
  it("throws SkinValidationError for non-object input", () => {
    for (const bad of [null, undefined, 42, "skin", true]) {
      expect(() => validateSkinDefinition(bad)).toThrow(SkinValidationError);
    }
    expect(() => validateSkinDefinition(null)).toThrow("Skin definition must be an object");
  });

  it("trims string fields and validates polarity", () => {
    const def = validateSkinDefinition({
      name: "  my-skin  ",
      description: "  desc  ",
      polarity: "Light",
      tool_prefix: "  ┊  ",
    });
    expect(def.name).toBe("my-skin");
    expect(def.description).toBe("desc");
    expect(def.polarity).toBeUndefined(); // invalid polarity dropped
    expect(def.tool_prefix).toBe("  ┊  "); // tool_prefix is not trimmed
  });

  it("accepts only light/dark polarity", () => {
    expect(validateSkinDefinition({ polarity: "light" }).polarity).toBe("light");
    expect(validateSkinDefinition({ polarity: "dark" }).polarity).toBe("dark");
  });

  it("normalizes hex colors (lowercase, shorthand expansion) and drops invalid ones", () => {
    const def = validateSkinDefinition({
      colors: {
        accent: "#FF7A3D",
        accent_border: "#abc",
        bad: "not-a-hex",
        invalid: "#12345",
        tooLong: "#123456789",
        numeric: 42,
        nullValue: null,
      },
    });
    expect(def.colors).toEqual({
      accent: "#ff7a3d",
      accent_border: "#aabbcc",
    });
  });

  it("expands 4/5-digit shorthand to 8 digits", () => {
    const def = validateSkinDefinition({ colors: { accent: "#ABCD" } });
    expect(def.colors?.accent).toBe("#aabbccdd");
  });

  it("validates light_colors and dark_colors the same way", () => {
    const def = validateSkinDefinition({
      light_colors: { ui_accent: "#FFF" },
      dark_colors: { status_ok: "#00FF00", broken: "##ff" },
    });
    expect(def.light_colors).toEqual({ ui_accent: "#ffffff" });
    expect(def.dark_colors).toEqual({ status_ok: "#00ff00" });
  });

  it("filters spinner arrays to strings and validates wings pairs", () => {
    const def = validateSkinDefinition({
      spinner: {
        waitingFaces: ["◐", 1, "◓"],
        thinking_faces: ["x"],
        thinking_verbs: "not-an-array",
        wings: [
          ["L", "R"],
          ["only-one"],
          "nope",
          [1, "two"],
        ],
      },
    });
    expect(def.spinner).toEqual({
      waitingFaces: ["◐", "◓"],
      thinkingFaces: ["x"],
      wings: [["L", "R"]],
    });
  });

  it("reads branding with camelCase first, snake_case fallback, trimmed", () => {
    const def = validateSkinDefinition({
      branding: {
        agentName: "  Ares  ",
        agent_name: "ignored",
        response_label: "Ares",
        promptSymbol: "⚔️",
        welcome: "Welcome.",
      },
    });
    expect(def.branding).toEqual({
      agentName: "Ares",
      responseLabel: "Ares",
      promptSymbol: "⚔️",
      welcome: "Welcome.",
      goodbye: undefined,
      helpHeader: undefined,
    });
  });

  it("keeps only string tool emojis", () => {
    const def = validateSkinDefinition({ tool_emojis: { bash: "⚔️", code: 42, empty: "" } });
    expect(def.tool_emojis).toEqual({ bash: "⚔️", empty: "" });
  });

  it("keeps banner strings", () => {
    const def = validateSkinDefinition({ banner_logo: "[bold #A93333]Ares[/]", banner_hero: "hi" });
    expect(def.banner_logo).toBe("[bold #A93333]Ares[/]");
    expect(def.banner_hero).toBe("hi");
  });

  it("drops unknown keys", () => {
    const def = validateSkinDefinition({ name: "x", made_up: 1, platforms: ["linux"] });
    expect("made_up" in def).toBe(false);
    expect("platforms" in def).toBe(false);
  });
});

describe("parseSkinSource", () => {
  it("throws for empty or whitespace-only source", () => {
    expect(() => parseSkinSource("")).toThrow(SkinValidationError);
    expect(() => parseSkinSource("   \n  ")).toThrow("Empty skin source");
  });

  it("parses JSON sources", () => {
    const def = parseSkinSource('{"name":"json-skin","colors":{"accent":"#FFF"}}');
    expect(def.name).toBe("json-skin");
    expect(def.colors).toEqual({ accent: "#ffffff" });
  });

  it("throws SkinValidationError for malformed JSON", () => {
    expect(() => parseSkinSource("{nope")).toThrow(SkinValidationError);
    expect(() => parseSkinSource("{nope")).toThrow(/Invalid JSON/);
  });

  it("is lenient for non-object JSON/YAML scalars (auto-detect only treats '{' as JSON)", () => {
    // '"str"', '[1,2]', '42' and 'null' do not start with '{', so they take the
    // YAML path and collapse to an empty definition rather than throwing.
    const empty = { colors: {}, light_colors: {}, dark_colors: {}, spinner: {}, branding: {}, tool_emojis: {} };
    expect(parseSkinSource('"str"')).toEqual(empty);
    expect(parseSkinSource("[1,2]")).toEqual(empty);
    expect(parseSkinSource("42")).toEqual(empty);
    expect(parseSkinSource("null")).toEqual(empty);
  });

  it("parses minimal YAML with nested maps", () => {
    const def = parseSkinSource(`name: yaml-skin
description: From YAML
colors:
  accent: '#a93333'
tool_emojis:
  bash: ⚔️
`);
    expect(def.name).toBe("yaml-skin");
    expect(def.description).toBe("From YAML");
    expect(def.colors).toEqual({ accent: "#a93333" });
    expect(def.tool_emojis).toEqual({ bash: "⚔️" });
  });

  it("strips YAML comments", () => {
    const def = parseSkinSource(`# top comment
name: commented # trailing comment
colors:
  accent: '#fff' # inline comment
`);
    expect(def.name).toBe("commented");
    expect(def.colors).toEqual({ accent: "#ffffff" });
  });

  it("parses YAML block lists under a key", () => {
    const def = parseSkinSource(`spinner:
  waiting_faces:
    - ◐
    - ◓
  thinking_verbs:
    - thinking
`);
    expect(def.spinner?.waitingFaces).toEqual(["◐", "◓"]);
    expect(def.spinner?.thinkingVerbs).toEqual(["thinking"]);
  });

  it("parses unquoted and quoted YAML scalars", () => {
    const def = parseSkinSource(`name: unquoted
description: "double quoted"
`);
    expect(def.name).toBe("unquoted");
    expect(def.description).toBe("double quoted");
  });

  it("drops non-string YAML scalars from string fields", () => {
    const def = parseSkinSource(`name: 123
banner_hero: true
`);
    expect(def.name).toBeUndefined();
    expect(def.banner_hero).toBeUndefined();
  });
});

describe("buildSkinPreset", () => {
  it("merges an empty definition over the base preset (user source)", () => {
    const preset = buildSkinPreset("ares", {});
    expect(preset.source).toBe("user");
    expect(preset.name).toBe("Ares"); // falls back to the base preset label
    expect(preset.polarity).toBe("dark");
    expect(preset.tokenOverrides.accent).toBe("#a93333");
    expect(preset.toolEmojis.execute_code).toBe("💻");
    expect(preset.bannerLogo).toBe("[bold #A93333]Ares[/]");
    expect(preset.branding.agentName).toBe("Ares");
  });

  it("uses the definition name/description when provided", () => {
    const preset = buildSkinPreset("ares", { name: "My Ares", description: "Custom" });
    expect(preset.name).toBe("My Ares");
    expect(preset.description).toBe("Custom");
  });

  it("falls back to the base name for blank names", () => {
    expect(buildSkinPreset("slate", { name: "   " }).name).toBe("Slate");
  });

  it("merges color overrides over the base token map", () => {
    const preset = buildSkinPreset("default", { colors: { accent: "#111111" } });
    expect(preset.tokenOverrides.accent).toBe("#111111");
    expect(preset.tokenOverrides.accentContrast).toBe(DEFAULT_SKIN_PRESET.tokenOverrides.accentContrast);
  });

  it("uses light_colors when the definition is light polarity", () => {
    const preset = buildSkinPreset("default", {
      polarity: "light",
      colors: { accent: "#000000" },
      light_colors: { accent: "#eeeeee" },
      dark_colors: { accent: "#ffffff" },
    });
    expect(preset.polarity).toBe("light");
    expect(preset.tokenOverrides.accent).toBe("#eeeeee");
  });

  it("uses dark_colors when the definition is dark polarity", () => {
    const preset = buildSkinPreset("default", {
      colors: { accent: "#000000" },
      light_colors: { accent: "#eeeeee" },
      dark_colors: { accent: "#dddddd" },
    });
    expect(preset.polarity).toBe("dark"); // base polarity
    expect(preset.tokenOverrides.accent).toBe("#dddddd");
  });

  it("inherits the base polarity when the definition omits it", () => {
    expect(buildSkinPreset("daylight", {}).polarity).toBe("light");
    expect(buildSkinPreset("mono", {}).polarity).toBe("dark");
  });

  it("merges tool emoji and spinner overrides, keeping base entries", () => {
    const preset = buildSkinPreset("poseidon", {
      tool_emojis: { bash: "⚓" },
      spinner: { thinkingVerbs: ["sailing"] },
    });
    expect(preset.toolEmojis.execute_code).toBe("🐚"); // base kept
    expect(preset.toolEmojis.bash).toBe("⚓"); // override wins
    expect(preset.spinner.thinkingVerbs).toEqual(["sailing"]);
    expect(preset.spinner.waitingFaces).toEqual(BUILTIN_SKINS.poseidon.spinner.waitingFaces);
  });

  it("keeps base banner when the definition omits it", () => {
    expect(buildSkinPreset("ares", {}).bannerLogo).toBe("[bold #A93333]Ares[/]");
  });
});

describe("loadSkinFromSource", () => {
  it("parses and builds a complete preset from a YAML source", () => {
    const preset = loadSkinFromSource("default", `name: custom
colors:
  accent: '#123456'
branding:
  agentName: Custom
`);
    expect(preset.slug).toBe("default");
    expect(preset.source).toBe("user");
    expect(preset.name).toBe("custom");
    expect(preset.tokenOverrides.accent).toBe("#123456");
    expect(preset.branding.agentName).toBe("Custom");
    expect(preset.branding.responseLabel).toBe(DEFAULT_SKIN_PRESET.branding.responseLabel);
  });

  it("parses and builds a complete preset from a JSON source", () => {
    const preset = loadSkinFromSource("ares", JSON.stringify({ name: "json-ares", tool_emojis: { bash: "🗡️" } }));
    expect(preset.name).toBe("json-ares");
    expect(preset.toolEmojis.bash).toBe("🗡️");
    expect(preset.tokenOverrides.accent).toBe("#a93333");
  });

  it("throws for empty sources", () => {
    expect(() => loadSkinFromSource("default", "")).toThrow(SkinValidationError);
  });

  it("produces a fully populated preset (all sections defined)", () => {
    const preset = loadSkinFromSource("default", "name: tiny");
    const required: Array<keyof SkinPreset> = [
      "slug",
      "name",
      "description",
      "source",
      "polarity",
      "tokenOverrides",
      "branding",
      "spinner",
      "toolEmojis",
    ];
    for (const key of required) {
      expect(preset[key]).toBeDefined();
    }
  });
});
