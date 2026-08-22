/**
 * Skin/theme presets for Hermes Agent CN Desktop.
 *
 * A skin layers accent colours, branding strings, spinner metadata and tool
 * emoji overrides on top of the existing structural UI theme.  Skins are
 * applied via `data-skin="<slug>"` on the document element; the companion
 * `skins.css` file maps each preset onto `--h-*` CSS custom properties.
 *
 * This module intentionally does **not** depend on PyYAML or the filesystem.
 * Built-ins are TypeScript constants.  User-defined skins are parsed from a
 * small YAML/JSON subset that mirrors the CLI skin-engine schema; unknown keys
 * are dropped and invalid hex values are rejected.
 */

export type SkinSlug =
  | "default"
  | "dark"
  | "light"
  | "high-contrast"
  | "midnight"
  | "ocean"
  | "forest"
  | "ares"
  | "mono"
  | "slate"
  | "daylight"
  | "warm-lightmode"
  | "poseidon"
  | "sisyphus";

export type SkinPolarity = "dark" | "light";

export type SkinToken =
  | "accent"
  | "accentSoft"
  | "accentBorder"
  | "accentContrast"
  | "statusOk"
  | "statusWarn"
  | "statusDanger"
  | "codeBg"
  | "diffAdded"
  | "diffRemoved";

export interface SkinBranding {
  agentName: string;
  responseLabel: string;
  promptSymbol?: string;
  welcome?: string;
  goodbye?: string;
  helpHeader?: string;
}

export interface SkinSpinner {
  waitingFaces: string[];
  thinkingFaces: string[];
  thinkingVerbs: string[];
  /** Pairs of left/right spinner frames. */
  wings: Array<[string, string]>;
}

export interface SkinPreset {
  slug: SkinSlug;
  name: string;
  description: string;
  source: "builtin" | "user";
  polarity: SkinPolarity;
  /** Semantic colour overrides mapped to shared-ui tokens. */
  tokenOverrides: Partial<Record<SkinToken, string>>;
  branding: SkinBranding;
  spinner: SkinSpinner;
  /** Per-tool emoji overrides. */
  toolEmojis: Record<string, string>;
  /** Optional ASCII / Rich-subset banner art. */
  bannerLogo?: string;
  /** Optional hero banner text. */
  bannerHero?: string;
}

/** Raw shape accepted by the YAML/JSON parser before validation/normalization. */
export interface SkinDefinition {
  name?: string;
  description?: string;
  polarity?: SkinPolarity;
  colors?: Record<string, string>;
  light_colors?: Record<string, string>;
  dark_colors?: Record<string, string>;
  spinner?: Partial<SkinSpinner>;
  branding?: Partial<SkinBranding>;
  tool_prefix?: string;
  tool_emojis?: Record<string, string>;
  banner_logo?: string;
  banner_hero?: string;
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isHex(value: string): boolean {
  return HEX_RE.test(value);
}

function normalizeHex(value: string): string {
  const trimmed = value.trim();
  if (!isHex(trimmed)) return "";
  // Expand 3/4-digit shorthand to 6/8 digits.
  if (trimmed.length === 4 || trimmed.length === 5) {
    const digits = trimmed.slice(1).split("");
    return "#" + digits.map((d) => d + d).join("");
  }
  return trimmed.toLowerCase();
}

const TOKEN_MAP: Record<string, SkinToken | undefined> = {
  accent: "accent",
  ui_accent: "accent",
  accent_soft: "accentSoft",
  accent_border: "accentBorder",
  accent_contrast: "accentContrast",
  status_ok: "statusOk",
  ok: "statusOk",
  status_warn: "statusWarn",
  warn: "statusWarn",
  status_danger: "statusDanger",
  danger: "statusDanger",
  error: "statusDanger",
  code_bg: "codeBg",
  diff_added: "diffAdded",
  diff_removed: "diffRemoved",
};

function mapColorKey(key: string): SkinToken | undefined {
  return TOKEN_MAP[key];
}

function pickPolarityColors(
  colors: Record<string, string> | undefined,
  lightColors: Record<string, string> | undefined,
  darkColors: Record<string, string> | undefined,
  targetPolarity: SkinPolarity,
): Partial<Record<SkinToken, string>> {
  // If a paired pole exists, merge it over the generic palette; otherwise use
  // the generic palette directly.
  const base = { ...colors };
  const pole = targetPolarity === "light" ? lightColors : darkColors;
  const merged = pole ? { ...base, ...pole } : base;
  const out: Partial<Record<SkinToken, string>> = {};
  for (const [key, value] of Object.entries(merged)) {
    const token = mapColorKey(key);
    if (!token) continue;
    const hex = normalizeHex(value);
    if (hex) out[token] = hex;
  }
  return out;
}

function assertSpinnerShape(value: unknown): Partial<SkinSpinner> {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const get = (...keys: string[]) => {
    for (const key of keys) {
      if (key in input) return input[key];
    }
    return undefined;
  };
  const out: Partial<SkinSpinner> = {};
  const waitingFaces = get("waitingFaces", "waiting_faces");
  if (Array.isArray(waitingFaces)) {
    out.waitingFaces = waitingFaces.filter((f): f is string => typeof f === "string");
  }
  const thinkingFaces = get("thinkingFaces", "thinking_faces");
  if (Array.isArray(thinkingFaces)) {
    out.thinkingFaces = thinkingFaces.filter((f): f is string => typeof f === "string");
  }
  const thinkingVerbs = get("thinkingVerbs", "thinking_verbs");
  if (Array.isArray(thinkingVerbs)) {
    out.thinkingVerbs = thinkingVerbs.filter((f): f is string => typeof f === "string");
  }
  const wings = get("wings");
  if (Array.isArray(wings)) {
    out.wings = wings
      .filter((w): w is [string, string] => Array.isArray(w) && w.length >= 2 && typeof w[0] === "string" && typeof w[1] === "string")
      .map((w) => [w[0], w[1]]);
  }
  return out;
}

function assertBrandingShape(value: unknown): Partial<SkinBranding> {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const pick = (k: keyof SkinBranding): string | undefined => {
    const v = input[k] ?? input[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
    return typeof v === "string" ? v.trim() : undefined;
  };
  return {
    agentName: pick("agentName"),
    responseLabel: pick("responseLabel"),
    promptSymbol: pick("promptSymbol"),
    welcome: pick("welcome"),
    goodbye: pick("goodbye"),
    helpHeader: pick("helpHeader"),
  };
}

function assertHexRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    const hex = normalizeHex(v);
    if (hex) out[k] = hex;
  }
  return out;
}

function assertRecordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function validateSkinDefinition(input: unknown): SkinDefinition {
  if (!input || typeof input !== "object") {
    throw new SkinValidationError("Skin definition must be an object");
  }
  const def = input as Record<string, unknown>;

  const out: SkinDefinition = {};
  if (typeof def.name === "string") out.name = def.name.trim();
  if (typeof def.description === "string") out.description = def.description.trim();
  if (def.polarity === "light" || def.polarity === "dark") out.polarity = def.polarity;

  out.colors = assertHexRecord(def.colors);
  out.light_colors = assertHexRecord(def.light_colors);
  out.dark_colors = assertHexRecord(def.dark_colors);

  out.spinner = assertSpinnerShape(def.spinner);
  out.branding = assertBrandingShape(def.branding);

  if (typeof def.tool_prefix === "string") out.tool_prefix = def.tool_prefix;
  out.tool_emojis = assertRecordOfStrings(def.tool_emojis);

  if (typeof def.banner_logo === "string") out.banner_logo = def.banner_logo;
  if (typeof def.banner_hero === "string") out.banner_hero = def.banner_hero;

  return out;
}

export class SkinValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkinValidationError";
  }
}

const DEFAULT_SPINNER: SkinSpinner = {
  waitingFaces: ["◐", "◓", "◑", "◒"],
  thinkingFaces: ["◐", "◓", "◑", "◒"],
  thinkingVerbs: ["thinking", "working", "reasoning"],
  wings: [
    ["◜", "◝"],
    ["◠", "◡"],
    ["◟", "◞"],
    ["◜", "◝"],
  ],
};

const DEFAULT_BRANDING: SkinBranding = {
  agentName: "Hermes",
  responseLabel: "Hermes",
  promptSymbol: "❯",
};

export const DEFAULT_SKIN_PRESET: SkinPreset = {
  slug: "default",
  name: "Default",
  description: "Hermes default gold accent on the active UI theme.",
  source: "builtin",
  polarity: "dark",
  tokenOverrides: {
    accent: "#ff7a3d",
    accentSoft: "rgba(255, 122, 61, 0.12)",
    accentBorder: "rgba(255, 122, 61, 0.36)",
    accentContrast: "#ffffff",
    statusOk: "#6b8e5a",
    statusWarn: "#c08828",
    statusDanger: "#c4554d",
    codeBg: "#f7f6f1",
    diffAdded: "#6b8e5a",
    diffRemoved: "#c4554d",
  },
  branding: { ...DEFAULT_BRANDING },
  spinner: { ...DEFAULT_SPINNER },
  toolEmojis: {},
};

function buildPreset(
  slug: SkinSlug,
  name: string,
  description: string,
  polarity: SkinPolarity,
  colors: Partial<Record<SkinToken, string>>,
  overrides: Partial<Omit<SkinPreset, "slug" | "name" | "description" | "polarity" | "tokenOverrides">> = {},
): SkinPreset {
  return {
    slug,
    name,
    description,
    source: "builtin",
    polarity,
    tokenOverrides: { ...DEFAULT_SKIN_PRESET.tokenOverrides, ...colors },
    branding: { ...DEFAULT_BRANDING, ...(overrides.branding ?? {}) },
    spinner: {
      waitingFaces: overrides.spinner?.waitingFaces ?? DEFAULT_SPINNER.waitingFaces,
      thinkingFaces: overrides.spinner?.thinkingFaces ?? DEFAULT_SPINNER.thinkingFaces,
      thinkingVerbs: overrides.spinner?.thinkingVerbs ?? DEFAULT_SPINNER.thinkingVerbs,
      wings: overrides.spinner?.wings ?? DEFAULT_SPINNER.wings,
    },
    toolEmojis: overrides.toolEmojis ?? {},
    bannerLogo: overrides.bannerLogo,
    bannerHero: overrides.bannerHero,
  };
}

export const BUILTIN_SKINS: Record<SkinSlug, SkinPreset> = {
  default: DEFAULT_SKIN_PRESET,
  dark: buildPreset(
    "dark",
    "Dark",
    "Warm amber accent for dark surfaces.",
    "dark",
    {
      accent: "#ff8c42",
      accentSoft: "rgba(255, 140, 66, 0.14)",
      accentBorder: "rgba(255, 140, 66, 0.38)",
      accentContrast: "#111111",
      codeBg: "#1a1a1a",
    },
  ),
  light: buildPreset(
    "light",
    "Light",
    "Soft blue accent for light surfaces.",
    "light",
    {
      accent: "#4a90d9",
      accentSoft: "rgba(74, 144, 217, 0.12)",
      accentBorder: "rgba(74, 144, 217, 0.34)",
      accentContrast: "#ffffff",
      codeBg: "#f5f8fc",
    },
  ),
  "high-contrast": buildPreset(
    "high-contrast",
    "High Contrast",
    "Maximum contrast with a bold red accent.",
    "dark",
    {
      accent: "#ff0000",
      accentSoft: "#ffffff",
      accentBorder: "#ffffff",
      accentContrast: "#ffffff",
      statusOk: "#00ff00",
      statusWarn: "#ffff00",
      statusDanger: "#ff0000",
      codeBg: "#000000",
      diffAdded: "#00ff00",
      diffRemoved: "#ff0000",
    },
  ),
  midnight: buildPreset(
    "midnight",
    "Midnight",
    "Deep blue accent on midnight surfaces.",
    "dark",
    {
      accent: "#5b8def",
      accentSoft: "rgba(91, 141, 239, 0.14)",
      accentBorder: "rgba(91, 141, 239, 0.38)",
      accentContrast: "#ffffff",
      codeBg: "#10182b",
    },
  ),
  ocean: buildPreset(
    "ocean",
    "Ocean",
    "Teal and cyan sea tones.",
    "dark",
    {
      accent: "#00a8b5",
      accentSoft: "rgba(0, 168, 181, 0.14)",
      accentBorder: "rgba(0, 168, 181, 0.38)",
      accentContrast: "#ffffff",
      codeBg: "#0a2326",
      statusOk: "#2ecc71",
    },
  ),
  forest: buildPreset(
    "forest",
    "Forest",
    "Muted forest green accent.",
    "dark",
    {
      accent: "#5a9e5a",
      accentSoft: "rgba(90, 158, 90, 0.14)",
      accentBorder: "rgba(90, 158, 90, 0.38)",
      accentContrast: "#ffffff",
      codeBg: "#102612",
      statusOk: "#4caf50",
    },
  ),
  ares: buildPreset(
    "ares",
    "Ares",
    "Crimson and bronze war theme.",
    "dark",
    {
      accent: "#a93333",
      accentSoft: "rgba(169, 51, 51, 0.14)",
      accentBorder: "rgba(169, 51, 51, 0.38)",
      accentContrast: "#ffffff",
      codeBg: "#2a1a1a",
      statusDanger: "#c4554d",
    },
    {
      branding: {
        agentName: "Ares",
        responseLabel: "Ares",
        promptSymbol: "⚔️",
        welcome: "Welcome, warrior.",
        goodbye: "Fight on.",
      },
      spinner: {
        waitingFaces: ["◐", "◓", "◑", "◒"],
        thinkingFaces: ["⚔️", "🛡️", "🔥", "🏹"],
        thinkingVerbs: ["forging", "charging", "rallying"],
        wings: [
          ["◜", "◝"],
          ["◠", "◡"],
        ],
      },
      toolEmojis: {
        execute_code: "💻",
        search_files: "🔍",
        bash: "⚔️",
      },
      bannerLogo: "[bold #A93333]Ares[/]",
    },
  ),
  mono: buildPreset(
    "mono",
    "Mono",
    "Grayscale accent for distraction-free focus.",
    "dark",
    {
      accent: "#9e9e9e",
      accentSoft: "rgba(158, 158, 158, 0.14)",
      accentBorder: "rgba(158, 158, 158, 0.36)",
      accentContrast: "#000000",
      codeBg: "#1a1a1a",
    },
    {
      branding: { agentName: "Hermes", responseLabel: "Hermes", promptSymbol: "▪" },
    },
  ),
  slate: buildPreset(
    "slate",
    "Slate",
    "Royal blue accent on cool grey surfaces.",
    "dark",
    {
      accent: "#7eb8f6",
      accentSoft: "rgba(126, 184, 246, 0.14)",
      accentBorder: "rgba(126, 184, 246, 0.38)",
      accentContrast: "#0a1929",
      codeBg: "#151f2b",
    },
  ),
  daylight: buildPreset(
    "daylight",
    "Daylight",
    "Bright light theme with coral warmth.",
    "light",
    {
      accent: "#ff7043",
      accentSoft: "rgba(255, 112, 67, 0.12)",
      accentBorder: "rgba(255, 112, 67, 0.32)",
      accentContrast: "#ffffff",
      codeBg: "#fff8f5",
    },
  ),
  "warm-lightmode": buildPreset(
    "warm-lightmode",
    "Warm Light",
    "Warm cream light mode with amber accent.",
    "light",
    {
      accent: "#e67e22",
      accentSoft: "rgba(230, 126, 34, 0.12)",
      accentBorder: "rgba(230, 126, 34, 0.32)",
      accentContrast: "#ffffff",
      codeBg: "#fffaf3",
      statusWarn: "#d68910",
    },
  ),
  poseidon: buildPreset(
    "poseidon",
    "Poseidon",
    "Aqua and sea-foam character theme.",
    "dark",
    {
      accent: "#00bcd4",
      accentSoft: "rgba(0, 188, 212, 0.14)",
      accentBorder: "rgba(0, 188, 212, 0.38)",
      accentContrast: "#002a30",
      codeBg: "#0a2326",
    },
    {
      branding: {
        agentName: "Poseidon",
        responseLabel: "Poseidon",
        promptSymbol: "🔱",
        welcome: "The tide rises.",
      },
      spinner: {
        waitingFaces: ["◐", "◓", "◑", "◒"],
        thinkingFaces: ["🌊", "🔱", "🐚", "🐟"],
        thinkingVerbs: ["divining", "tiding", "flowing"],
        wings: [
          ["◜", "◝"],
          ["◠", "◡"],
        ],
      },
      toolEmojis: {
        execute_code: "🐚",
        web_search: "🌊",
      },
    },
  ),
  sisyphus: buildPreset(
    "sisyphus",
    "Sisyphus",
    "Muted stone and boulder-grey perseverance theme.",
    "dark",
    {
      accent: "#8d8d8d",
      accentSoft: "rgba(141, 141, 141, 0.14)",
      accentBorder: "rgba(141, 141, 141, 0.36)",
      accentContrast: "#ffffff",
      codeBg: "#232323",
    },
    {
      branding: {
        agentName: "Sisyphus",
        responseLabel: "Sisyphus",
        promptSymbol: "🪨",
      },
      spinner: {
        waitingFaces: ["◐", "◓", "◑", "◒"],
        thinkingFaces: ["🪨", "⛰️", "🏔️"],
        thinkingVerbs: ["pushing", "climbing", "enduring"],
        wings: [
          ["◜", "◝"],
          ["◠", "◡"],
        ],
      },
    },
  ),
};

export const BUILTIN_SKIN_SLUGS = Object.freeze(Object.keys(BUILTIN_SKINS) as SkinSlug[]);

export function isSkinSlug(value: unknown): value is SkinSlug {
  return typeof value === "string" && value in BUILTIN_SKINS;
}

export function getSkinBySlug(slug: SkinSlug): SkinPreset {
  return BUILTIN_SKINS[slug] ?? BUILTIN_SKINS.default;
}

export function listSkinSlugs(): readonly SkinSlug[] {
  return BUILTIN_SKIN_SLUGS;
}

export function listSkins(): readonly SkinPreset[] {
  return BUILTIN_SKIN_SLUGS.map((slug) => BUILTIN_SKINS[slug]);
}

/**
 * Merge a parsed user skin definition over the default built-in, producing a
 * fully populated preset.  The resulting slug is always the supplied `slug`;
 * if the definition omits a name the slug is used as a label.
 */
export function buildSkinPreset(slug: SkinSlug, definition: SkinDefinition): SkinPreset {
  const base = getSkinBySlug(slug);
  const polarity = definition.polarity ?? base.polarity;
  const colors = pickPolarityColors(
    definition.colors,
    definition.light_colors,
    definition.dark_colors,
    polarity,
  );
  const spinnerIn = definition.spinner ?? {};
  const brandingIn = definition.branding ?? {};

  return {
    slug,
    name: definition.name?.trim() || base.name,
    description: definition.description?.trim() || base.description,
    source: "user",
    polarity,
    tokenOverrides: { ...base.tokenOverrides, ...colors },
    branding: {
      agentName: brandingIn.agentName?.trim() || base.branding.agentName,
      responseLabel: brandingIn.responseLabel?.trim() || base.branding.responseLabel,
      promptSymbol: brandingIn.promptSymbol?.trim() || base.branding.promptSymbol,
      welcome: brandingIn.welcome?.trim() || base.branding.welcome,
      goodbye: brandingIn.goodbye?.trim() || base.branding.goodbye,
      helpHeader: brandingIn.helpHeader?.trim() || base.branding.helpHeader,
    },
    spinner: {
      waitingFaces: spinnerIn.waitingFaces ?? base.spinner.waitingFaces,
      thinkingFaces: spinnerIn.thinkingFaces ?? base.spinner.thinkingFaces,
      thinkingVerbs: spinnerIn.thinkingVerbs ?? base.spinner.thinkingVerbs,
      wings: spinnerIn.wings ?? base.spinner.wings,
    },
    toolEmojis: { ...base.toolEmojis, ...(definition.tool_emojis ?? {}) },
    bannerLogo: definition.banner_logo ?? base.bannerLogo,
    bannerHero: definition.banner_hero ?? base.bannerHero,
  };
}

/**
 * Convert a SkinToken to the CSS custom-property name used by `skins.css` and
 * dynamic injection helpers.
 */
export function skinTokenToCssVar(token: SkinToken): string {
  const map: Record<SkinToken, string> = {
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
  return map[token];
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal YAML/JSON parser (no external parser dependency)
// ─────────────────────────────────────────────────────────────────────────────

interface YamlLine {
  indent: number;
  raw: string;
  key?: string;
  value?: string;
  isArrayItem: boolean;
}

function trimComment(line: string): string {
  // Remove inline comments, but keep # inside quoted strings.
  let result = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "#" && !inSingle && !inDouble) {
      break;
    }
    result += ch;
  }
  return result;
}

function splitKeyValue(line: string): { key?: string; value?: string } {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("- ")) return { value: trimmed.slice(2).trim() };
  const colon = trimmed.indexOf(":");
  if (colon === -1) return {};
  const key = trimmed.slice(0, colon).trim();
  const value = trimmed.slice(colon + 1).trim();
  return { key, value };
}

function tokenizeYaml(yaml: string): YamlLine[] {
  return yaml.split("\n").map((raw) => {
    const withoutComment = trimComment(raw);
    const trimmed = withoutComment.trimEnd();
    const isArrayItem = trimmed.trimStart().startsWith("- ");
    const indent = trimmed.length - trimmed.trimStart().length;
    const kv = splitKeyValue(trimmed);
    return { raw, indent, ...kv, isArrayItem };
  });
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "null" || trimmed === "~") return null;
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  if (/^[-+]?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^[-+]?\d*\.\d+$/.test(trimmed)) return Number(trimmed);
  // Strip matching quotes.
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseYamlBlock(lines: YamlLine[], start: number, baseIndent: number): { value: unknown; nextIndex: number } {
  const first = lines[start];
  if (!first) return { value: null, nextIndex: start };

  // Array block.
  if (first.isArrayItem) {
    const arr: unknown[] = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (line.indent !== first.indent || !line.isArrayItem) break;
      const itemValue = line.value ?? "";
      // Check if array item has nested children.
      if (i + 1 < lines.length && lines[i + 1].indent > line.indent) {
        const nested = parseYamlBlock(lines, i + 1, lines[i + 1].indent);
        i = nested.nextIndex;
        if (itemValue) {
          // Keyed array item, e.g. "- key: value".
          const kv = splitKeyValue("- " + itemValue);
          if (kv.key) {
            const obj: Record<string, unknown> = { [kv.key]: parseYamlScalar(kv.value ?? "") };
            if (nested.value && typeof nested.value === "object" && !Array.isArray(nested.value)) {
              Object.assign(obj, nested.value);
            }
            arr.push(obj);
          } else {
            arr.push(nested.value);
          }
        } else {
          arr.push(nested.value);
        }
      } else {
        arr.push(parseYamlScalar(itemValue));
        i++;
      }
    }
    return { value: arr, nextIndex: i };
  }

  // Object block.
  const obj: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < baseIndent) break;
    if (line.indent !== baseIndent || !line.key) {
      i++;
      continue;
    }
    const key = line.key;
    const hasInlineValue = line.value !== undefined && line.value !== "";

    if (i + 1 < lines.length && lines[i + 1].indent > line.indent) {
      // Nested mapping or array.
      const nested = parseYamlBlock(lines, i + 1, lines[i + 1].indent);
      i = nested.nextIndex;
      if (hasInlineValue) {
        obj[key] = { _inline: parseYamlScalar(line.value ?? ""), ...((nested.value as object) ?? {}) };
      } else {
        obj[key] = nested.value;
      }
    } else if (hasInlineValue) {
      obj[key] = parseYamlScalar(line.value ?? "");
      i++;
    } else {
      obj[key] = null;
      i++;
    }
  }
  return { value: obj, nextIndex: i };
}

function parseYamlDocument(yaml: string): unknown {
  const lines = tokenizeYaml(yaml).filter((l) => l.raw.trim() !== "" && !l.raw.trim().startsWith("#"));
  if (lines.length === 0) return {};
  const firstIndent = lines[0].indent;
  const result = parseYamlBlock(lines, 0, firstIndent);
  return result.value;
}

/**
 * Parse a skin from a YAML or JSON string.  Auto-detects the format: strings
 * starting with `{` are parsed as JSON; everything else as YAML.
 *
 * Returns a validated {@link SkinDefinition}.  Throws {@link SkinValidationError}
 * for malformed input.
 */
export function parseSkinSource(source: string): SkinDefinition {
  const trimmed = source.trim();
  if (!trimmed) throw new SkinValidationError("Empty skin source");
  let parsed: unknown;
  if (trimmed.startsWith("{")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new SkinValidationError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    parsed = parseYamlDocument(trimmed);
  }
  return validateSkinDefinition(parsed);
}

/**
 * Parse a skin source and build a complete preset from it.
 */
export function loadSkinFromSource(slug: SkinSlug, source: string): SkinPreset {
  const def = parseSkinSource(source);
  return buildSkinPreset(slug, def);
}
