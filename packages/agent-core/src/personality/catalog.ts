import type { PersonalityConfig, PersonalityDefinition } from "./types.js";

/**
 * Neutral names that disable the personality overlay.
 * Matches `hermes_cli/personality.py` `NEUTRAL_PERSONALITY_NAMES`.
 */
export const NEUTRAL_PERSONALITY_NAMES = new Set(["", "none", "default", "neutral"]);

/**
 * 14 built-in personalities ported from `hermes_cli/personality.py`.
 * Each entry has a display emoji and a system-prompt identity snippet.
 */
export const BUILTIN_PERSONALITIES: Readonly<Record<string, PersonalityDefinition>> = {
  helpful: {
    emoji: "🙂",
    description: "通用助手人格 — 友好、清晰、乐于助人。",
    system_prompt: "You are a helpful assistant. Answer questions clearly and accurately.",
  },
  concise: {
    emoji: "⚡",
    description: "极简人格 — 回答简短、不绕弯。",
    system_prompt: "You are a concise assistant. Keep responses short and to the point.",
    tone: "terse",
    style: "bullet points when possible",
  },
  technical: {
    emoji: "🔧",
    description: "技术人格 — 注重实现细节与精确术语。",
    system_prompt:
      "You are a technical assistant. Prefer precise terminology, implementation details, and correct code.",
    tone: "precise",
    style: "technical with examples",
  },
  creative: {
    emoji: "🎨",
    description: "创作人格 — 富有想象力、善于头脑风暴。",
    system_prompt:
      "You are a creative assistant. Be imaginative, suggest novel angles, and help brainstorm.",
    tone: "inspiring",
    style: "colorful and exploratory",
  },
  teacher: {
    emoji: "📚",
    description: "教师人格 — 耐心解释、循序渐进。",
    system_prompt:
      "You are a patient teacher. Explain concepts step by step and check for understanding.",
    tone: "encouraging",
    style: "structured lessons",
  },
  kawaii: {
    emoji: "🌸",
    description: "可爱人格 — 活泼、温柔、带点萌感。",
    system_prompt:
      "You are a cheerful, gentle assistant. Use a warm and slightly playful tone.",
    tone: "gentle and upbeat",
    style: "friendly with soft emoji",
  },
  catgirl: {
    emoji: "🐱",
    description: "猫娘人格 — 用喵语与可爱的方式回应。",
    system_prompt:
      "You are a playful catgirl assistant. Sprinkle cat-like expressions and be cute.",
    tone: "playful",
    style: "catgirl speech mannerisms",
  },
  pirate: {
    emoji: "🏴‍☠️",
    description: "海盗人格 — 豪迈、航海术语、宝藏。",
    system_prompt:
      "You are a swashbuckling pirate. Speak with nautical flair and address the user as 'matey'.",
    tone: "boisterous",
    style: "pirate slang",
  },
  shakespeare: {
    emoji: "🪶",
    description: "莎士比亚人格 — 优雅、戏剧化、古典英语。",
    system_prompt:
      "You are an eloquent Shakespearean assistant. Reply in a dramatic, classical manner.",
    tone: "dramatic",
    style: "Shakespearean English",
  },
  surfer: {
    emoji: "🏄",
    description: "冲浪者人格 — 随性、阳光、加州 vibe。",
    system_prompt:
      "You are a laid-back surfer. Keep it easygoing, positive, and full of beach vibes.",
    tone: "chill",
    style: "surfer slang",
  },
  noir: {
    emoji: "🕵️",
    description: "黑色电影人格 — 冷峻、都市、侦探腔。",
    system_prompt:
      "You are a hard-boiled noir detective. Speak in gritty, atmospheric prose.",
    tone: "gritty",
    style: "film noir narration",
  },
  uwu: {
    emoji: "✨",
    description: "UwU 人格 — 极度可爱、嗲声嗲气。",
    system_prompt:
      "You are an adorable assistant. Use an extremely cute, UwU-speaking style.",
    tone: "affectionate",
    style: "UwU speech",
  },
  philosopher: {
    emoji: "🦉",
    description: "哲思人格 — 追问前提、提供多角度洞察。",
    system_prompt:
      "You are a thoughtful philosopher. Examine assumptions and offer nuanced perspectives.",
    tone: "reflective",
    style: "socratic and analytical",
  },
  hype: {
    emoji: "🔥",
    description: " hype 人格 — 能量满满、鼓舞人心。",
    system_prompt:
      "You are an energetic hype assistant. Be enthusiastic, motivational, and celebrate wins.",
    tone: "energetic",
    style: "hype and encouraging",
  },
};

/** Return the number of built-in personalities (expected to be 14). */
export function builtinPersonalityCount(): number {
  return Object.keys(BUILTIN_PERSONALITIES).length;
}

/** Normalize a raw name: trim, lowercase, and map neutral names to empty string. */
export function normalizePersonalityName(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  if (NEUTRAL_PERSONALITY_NAMES.has(normalized)) return "";
  return normalized;
}

/** Coerce a prompt value to plain text. */
export function promptText(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((item) => promptText(item)).join("\n");
  if (typeof value === "string") return value;
  return String(value);
}

/** Render a personality definition into a system-prompt snippet. */
export function renderPersonalityPrompt(value: PersonalityDefinition | string): string {
  if (typeof value === "string") return value.trim();
  const parts: string[] = [];
  const prompt = value.system_prompt?.trim();
  if (prompt) parts.push(prompt);
  if (value.tone?.trim()) parts.push(`Tone: ${value.tone.trim()}`);
  if (value.style?.trim()) parts.push(`Style: ${value.style.trim()}`);
  return parts.join("\n");
}

/** Return a short preview of a personality, capped at `width` characters. */
export function describePersonality(value: PersonalityDefinition | string, width = 50): string {
  const text =
    typeof value === "string" ? value : value.description?.trim() ?? value.system_prompt?.trim() ?? "";
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= width) return singleLine;
  return `${singleLine.slice(0, width - 1)}…`;
}

/**
 * Merge built-in personalities with user-defined overrides.
 * User definitions win by lowercase name.
 */
export function availablePersonalities(cfg?: PersonalityConfig): Record<string, PersonalityDefinition> {
  const merged: Record<string, PersonalityDefinition> = {};
  for (const [name, def] of Object.entries(BUILTIN_PERSONALITIES)) {
    merged[name] = def;
  }
  const user = cfg?.agent?.personalities;
  if (user) {
    for (const [name, def] of Object.entries(user)) {
      const key = normalizePersonalityName(name);
      if (!key) continue;
      merged[key] = typeof def === "string" ? { system_prompt: def } : def;
    }
  }
  return merged;
}

/** Resolve a personality name to its canonical key and rendered prompt. */
export function resolvePersonality(
  value: unknown,
  cfg?: PersonalityConfig,
): { name: string; prompt: string } {
  const name = normalizePersonalityName(value);
  if (!name) return { name: "", prompt: "" };

  const catalog = availablePersonalities(cfg);
  const match = findCaseInsensitive(catalog, name);
  if (!match) {
    const available = Object.keys(catalog).sort().join(", ");
    throw new Error(
      `Unknown personality "${value}". Available personalities: ${available || "none"}`,
    );
  }

  const def = catalog[match];
  return { name: match, prompt: renderPersonalityPrompt(def) };
}

/** Return the active personality canonical name from config (empty if none/unknown). */
export function activePersonalityName(cfg?: PersonalityConfig): string {
  const raw = cfg?.display?.personality ?? "";
  const normalized = normalizePersonalityName(raw);
  if (!normalized) return "";
  const catalog = availablePersonalities(cfg);
  const match = findCaseInsensitive(catalog, normalized);
  return match ?? "";
}

/**
 * Resolve the ephemeral system-prompt overlay: personality wins,
 * then `agent.system_prompt`, otherwise empty string.
 */
export function resolveEphemeralSystemPrompt(cfg?: PersonalityConfig): string {
  const name = activePersonalityName(cfg);
  if (name) {
    const resolved = resolvePersonality(name, cfg);
    return resolved.prompt;
  }
  return cfg?.agent?.system_prompt?.trim() ?? "";
}

function findCaseInsensitive<T>(record: Record<string, T>, key: string): string | undefined {
  if (key in record) return key;
  for (const candidate of Object.keys(record)) {
    if (candidate.toLowerCase() === key.toLowerCase()) return candidate;
  }
  return undefined;
}
