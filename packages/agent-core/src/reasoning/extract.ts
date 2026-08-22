import type { ReasoningBlock, ReasoningSource } from "./types.js";

/**
 * Tag conventions used to delimit reasoning content in raw text streams.
 *
 * - Anthropic extended thinking exposes `thinking` blocks in the wire format,
 *   and some adapters render them as `<thinking>...</thinking>`.
 * - OpenAI reasoning content is normally a separate `reasoning_content` field,
 *   but we also accept `<reasoning>...</reasoning>` markers for parity.
 * - DeepSeek-R1 (and several Chinese-mirror proxies) wraps chain-of-thought in
 *   `\thiking` / `\thiking` (literal) tags.
 */
const SOURCE_TAGS: Record<ReasoningSource, string[]> = {
  anthropic: ["thinking"],
  openai: ["reasoning"],
  deepseek: ["think", "thiking"],
  plain: [],
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract reasoning blocks from a raw text string.
 *
 * Blocks are returned in the order they appear. Nested or overlapping tags are
 * not supported; each opening tag is closed by the next matching closing tag.
 */
export function extractReasoningBlocks(text: string): ReasoningBlock[] {
  const blocks: ReasoningBlock[] = [];
  if (typeof text !== "string" || !text) return blocks;

  for (const [source, tags] of Object.entries(SOURCE_TAGS) as [
    ReasoningSource,
    string[],
  ][]) {
    for (const tag of tags) {
      // XML-style tags: <think>...</think>
      const open = escapeRegExp(`<${tag}>`);
      const close = escapeRegExp(`</${tag}>`);
      const pattern = new RegExp(`${open}\\s*([\\s\\S]*?)\\s*${close}`, "g");
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        blocks.push({
          source,
          content: match[1].trim(),
        });
      }

    }
  }

  // Literal backslash tags used by some DeepSeek-R1 shims: \think...\think
  const literalPattern = /\\think\s*([\s\S]*?)\s*\\think/g;
  let literalMatch: RegExpExecArray | null;
  while ((literalMatch = literalPattern.exec(text)) !== null) {
    blocks.push({
      source: "deepseek",
      content: literalMatch[1].trim(),
    });
  }

  return blocks;
}

/**
 * Extract reasoning from an OpenAI-style response object.
 *
 * The reasoning content may live in the dedicated `reasoning_content` field,
 * or (for some provider shims) in the `reasoning` field. If neither exists,
 * fallback tag extraction is applied to the `content` field.
 */
export function extractOpenAIReasoning(
  response: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
  },
): ReasoningBlock[] {
  const raw = response.reasoning_content ?? response.reasoning;
  if (typeof raw === "string" && raw.length > 0) {
    return [{ source: "openai", content: raw }];
  }
  return extractReasoningBlocks(response.content ?? "");
}

/**
 * Extract reasoning from an Anthropic message, including redacted-thinking
 * blocks. Redacted blocks are preserved with an empty `content` and the base64
 * data stored in `signature`.
 */
export function extractAnthropicReasoning(
  contentBlocks: unknown[],
): ReasoningBlock[] {
  const blocks: ReasoningBlock[] = [];
  if (!Array.isArray(contentBlocks)) return blocks;

  for (const block of contentBlocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = b.type;
    if (type === "thinking" && typeof b.thinking === "string") {
      blocks.push({
        source: "anthropic",
        content: b.thinking,
        signature:
          typeof b.signature === "string" ? b.signature : undefined,
      });
    } else if (type === "redacted_thinking" && typeof b.data === "string") {
      blocks.push({
        source: "anthropic",
        content: "",
        signature: b.data,
      });
    } else if (typeof b.text === "string") {
      const extracted = extractReasoningBlocks(b.text);
      blocks.push(...extracted);
    }
  }

  return blocks;
}

/**
 * Remove all recognized reasoning delimiters from `text` and collapse the
 * surrounding whitespace.
 */
export function stripReasoning(text: string): string {
  let cleaned = text;
  for (const tags of Object.values(SOURCE_TAGS)) {
    for (const tag of tags) {
      const open = escapeRegExp(`<${tag}>`);
      const close = escapeRegExp(`</${tag}>`);
      const pattern = new RegExp(`${open}\\s*[\\s\\S]*?\\s*${close}`, "g");
      cleaned = cleaned.replace(pattern, "\n");
    }
  }
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}
