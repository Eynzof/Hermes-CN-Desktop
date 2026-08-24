/**
 * Model-name → (max_context_size, max_tokens) resolution for the local
 * (no-backend) chat engine.
 *
 * Ported from kimi-agent's `kimi-cli/src/kimi_cli/config.py`:
 * `_MODEL_DEFAULTS` + `_resolve_model_defaults` + the LLMModel validator's
 * `max_context_size // 4` fallback. The local engine uses it to derive the
 * `max_tokens` it sends to OpenAI-compatible endpoints instead of a hard-coded
 * budget, so reasoning-heavy models get room to produce a final `content`.
 *
 * Matching is token-based and tolerates different separators and minor typos
 * in alphabetic keywords while keeping version numbers exact.
 */

export interface ModelDefaults {
  maxContextSize: number;
  maxTokens: number | null;
}

/** Conservative budget for models that match no known keyword set and have no
 *  configured context length. */
export const DEFAULT_LOCAL_MAX_TOKENS = 4096;

//: Minimum token-level fuzzy ratio required for an alphabetic keyword token
//: to match a model-name token when an exact match is not available.
const FUZZY_TOKEN_THRESHOLD = 80;

//: Tokenization pattern for model names and keyword phrases (mirrors the
//: Python `_KEYWORD_SPLIT_RE`).
const KEYWORD_SPLIT_RE = /[^a-z0-9]+/g;

//: (keywords, max_context_size, max_output). All keyword tokens must be present
//: in the tokenized model name; more specific entries must appear first.
const MODEL_DEFAULTS: Array<{
  keywords: string[];
  maxContextSize: number;
  maxTokens: number | null;
}> = [
  // OpenAI GPT
  { keywords: ["gpt-5.6", "sol"], maxContextSize: 1_050_000, maxTokens: 128_000 },
  { keywords: ["gpt-5.5"], maxContextSize: 1_050_000, maxTokens: 128_000 },
  { keywords: ["gpt-5.4", "mini"], maxContextSize: 1_000_000, maxTokens: 65_536 },
  { keywords: ["gpt-5.4"], maxContextSize: 1_000_000, maxTokens: 128_000 },
  // Anthropic Claude
  { keywords: ["claude", "opus", "5"], maxContextSize: 1_000_000, maxTokens: 128_000 },
  { keywords: ["claude", "opus", "4.8"], maxContextSize: 1_000_000, maxTokens: 128_000 },
  { keywords: ["claude", "sonnet", "5"], maxContextSize: 1_000_000, maxTokens: 128_000 },
  { keywords: ["claude", "sonnet", "4.6"], maxContextSize: 1_000_000, maxTokens: 64_000 },
  { keywords: ["claude", "haiku", "4.5"], maxContextSize: 200_000, maxTokens: 64_000 },
  // Google Gemini
  { keywords: ["gemini", "3.6"], maxContextSize: 1_048_576, maxTokens: 65_536 },
  { keywords: ["gemini", "3.5", "flash"], maxContextSize: 1_048_576, maxTokens: 65_536 },
  { keywords: ["gemini", "3.1", "pro"], maxContextSize: 1_048_576, maxTokens: 65_536 },
  // Amazon Nova
  { keywords: ["amazon", "nova", "2", "lite"], maxContextSize: 1_000_000, maxTokens: 64_000 },
  // DeepSeek
  { keywords: ["deepseek", "v4", "pro"], maxContextSize: 1_000_000, maxTokens: 384_000 },
  { keywords: ["deepseek", "v4", "flash"], maxContextSize: 1_000_000, maxTokens: 384_000 },
  // xAI Grok (no fixed output budget — falls back to context // 4)
  { keywords: ["supergrok", "heavy"], maxContextSize: 2_000_000, maxTokens: null },
  { keywords: ["grok"], maxContextSize: 2_000_000, maxTokens: null },
];

export function tokenizeModelName(name: string): string[] {
  return name.toLowerCase().split(KEYWORD_SPLIT_RE).filter(Boolean);
}

function isAlphaToken(token: string): boolean {
  return /^[a-z]+$/.test(token);
}

/**
 * difflib.SequenceMatcher-style ratio (2 × matching chars / combined length),
 * the same formula rapidfuzz.fuzz.ratio uses. Implemented as a small naive
 * longest-matching-block search — model-name tokens are short, so O(n³) is fine.
 */
function fuzzRatio(a: string, b: string): number {
  if (a === b) return 100;
  if (a.length === 0 || b.length === 0) return 0;

  const blocks: Array<[number, number, number]> = [];
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  while (queue.length > 0) {
    const [aStart, aEnd, bStart, bEnd] = queue.pop()!;
    let bestA = aStart;
    let bestB = bStart;
    let bestSize = 0;
    for (let i = aStart; i < aEnd; i += 1) {
      for (let j = bStart; j < bEnd; j += 1) {
        let size = 0;
        while (i + size < aEnd && j + size < bEnd && a[i + size] === b[j + size]) {
          size += 1;
        }
        if (size > bestSize) {
          bestSize = size;
          bestA = i;
          bestB = j;
        }
      }
    }
    if (bestSize === 0) continue;
    blocks.push([bestA, bestB, bestSize]);
    if (aStart < bestA && bStart < bestB) {
      queue.push([aStart, bestA, bStart, bestB]);
    }
    if (bestA + bestSize < aEnd && bestB + bestSize < bEnd) {
      queue.push([bestA + bestSize, aEnd, bestB + bestSize, bEnd]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  let matches = 0;
  for (const [, , size] of blocks) matches += size;
  return (2 * matches) / (a.length + b.length) * 100;
}

function keywordsMatch(keywords: string[], modelTokens: string[]): boolean {
  const remaining = new Map<string, number>();
  for (const token of modelTokens) {
    remaining.set(token, (remaining.get(token) ?? 0) + 1);
  }

  for (const keyword of keywords) {
    for (const keywordToken of tokenizeModelName(keyword)) {
      const exact = remaining.get(keywordToken) ?? 0;
      if (exact > 0) {
        remaining.set(keywordToken, exact - 1);
        continue;
      }

      if (!isAlphaToken(keywordToken)) return false;

      let bestMatch: string | null = null;
      let bestScore = -1;
      let bestCount = 0;
      for (const [modelToken, count] of remaining) {
        if (count <= 0 || !isAlphaToken(modelToken)) continue;
        const score = fuzzRatio(keywordToken, modelToken);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = modelToken;
          bestCount = count;
        }
      }
      if (bestMatch !== null && bestScore >= FUZZY_TOKEN_THRESHOLD) {
        remaining.set(bestMatch, bestCount - 1);
      } else {
        return false;
      }
    }
  }
  return true;
}

/**
 * Resolve `(max_context_size, max_tokens)` for a model name.
 * Returns null when the name does not match any known keyword set.
 */
export function resolveModelDefaults(modelName: string): ModelDefaults | null {
  const modelTokens = tokenizeModelName(modelName);
  for (const entry of MODEL_DEFAULTS) {
    if (keywordsMatch(entry.keywords, modelTokens)) {
      return { maxContextSize: entry.maxContextSize, maxTokens: entry.maxTokens };
    }
  }
  return null;
}

/**
 * Derive the `max_tokens` budget to send for a model name, mirroring
 * config.py's LLMModel validator:
 *   - known model with explicit max_output → that budget;
 *   - known model without max_output (or unknown name) → max_context_size // 4
 *     when a context length is available;
 *   - otherwise → DEFAULT_LOCAL_MAX_TOKENS.
 */
export function resolveModelMaxTokens(
  modelName: string,
  configuredContextLength?: number | null,
): number {
  const resolved = resolveModelDefaults(modelName);
  if (resolved) {
    if (resolved.maxTokens != null) return resolved.maxTokens;
    return Math.floor(resolved.maxContextSize / 4);
  }

  const contextLength =
    typeof configuredContextLength === "number" && Number.isFinite(configuredContextLength) &&
    configuredContextLength > 0
      ? configuredContextLength
      : null;
  if (contextLength != null) {
    return Math.floor(contextLength / 4);
  }
  return DEFAULT_LOCAL_MAX_TOKENS;
}
