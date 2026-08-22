/**
 * Per-provider prompt-cache hints.
 *
 * - Anthropic Messages: request-local `cache_control: { type: "ephemeral" }` on
 *   content blocks and tool definitions.
 * - OpenAI: no message-level marker; cache is implicit via recent
 *   `prompt_cache_key` / service-tier metadata. We only attach a metadata hint
 *   here so callers can forward it in `extraBody`.
 * - OpenRouter envelope: mirrors Anthropic markers *inside* message/tool
 *   content parts, never at the top level of a `role: "tool"` message.
 */

import type { Message, Tool } from "../types.js";
import type {
  AnthropicCacheControl,
  CacheControlOptions,
  CacheControlValue,
  CompactionMessage,
} from "./types.js";

export type { AnthropicCacheControl, OpenAiCachedTokenHint, CacheControlValue } from "./types.js";

export type CacheControlProvider = CacheControlOptions["provider"];

const EPHEMERAL: AnthropicCacheControl = { type: "ephemeral" };

export function isAnthropicProvider(provider: CacheControlProvider): boolean {
  return provider === "anthropic" || provider === "openrouter";
}

/**
 * Create a cache-control value for a message or tool block.
 * Returns `undefined` for providers that do not support block-level markers.
 */
export function createCacheControl(provider: CacheControlProvider): CacheControlValue | undefined {
  if (isAnthropicProvider(provider)) {
    return EPHEMERAL;
  }
  if (provider === "openai") {
    return { provider: "openai", metadata: { use_cached_tokens: true } };
  }
  return undefined;
}

/**
 * Attach Anthropic-style `cache_control` to the *last* content block of a
 * message. Top-level message `cache_control` is allowed for assistant/user
 * messages; OpenRouter prefers markers inside content parts.
 */
export function attachMessageCacheControl(
  message: CompactionMessage,
  provider: CacheControlProvider,
): CompactionMessage {
  if (!isAnthropicProvider(provider)) return message;
  const copy: CompactionMessage = { ...message };
  // OpenRouter envelope layout: marker lives inside content parts.
  if (provider === "openrouter" || typeof copy.content === "string") {
    copy.cache_control = EPHEMERAL;
  } else {
    copy.cache_control = EPHEMERAL;
  }
  return copy;
}

/**
 * Attach Anthropic-style `cache_control` to a tool definition. Returns a new
 * tool object; the canonical tool registry is left untouched.
 */
export function attachToolCacheControl(tool: Tool, provider: CacheControlProvider): Tool {
  if (!isAnthropicProvider(provider)) return tool;
  return {
    ...tool,
    cache_control: EPHEMERAL,
  } as Tool & { cache_control: AnthropicCacheControl };
}

/**
 * Strip every block-level `cache_control` field from messages and tools.
 * Call this before persisting or before re-decorating a failover request.
 */
export function stripCacheControl(messages: Message[], tools?: Tool[]): { messages: Message[]; tools?: Tool[] } {
  const cleanedMessages = messages.map((m) => {
    if ((m as CompactionMessage).cache_control === undefined) return m;
    const { cache_control: _, ...rest } = m as CompactionMessage;
    return rest as Message;
  });
  const cleanedTools = tools?.map((t) => {
    if (!(t as Tool & { cache_control?: unknown }).cache_control) return t;
    const { cache_control: _, ...rest } = t as Tool & { cache_control: unknown };
    return rest as Tool;
  });
  return { messages: cleanedMessages, tools: cleanedTools };
}

/**
 * OpenAI cached-token hint metadata. The caller merges this into the request
 * `extra_body` / `metadata` field depending on the SDK.
 */
export function buildOpenAiCacheMetadata(): Record<string, unknown> {
  return { use_cached_tokens: true };
}
