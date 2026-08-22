/**
 * Prompt-cache key tracking and Anthropic-style `cache_control` injection.
 *
 * The planner is intentionally provider-agnostic at the API level; concrete
 * marker shapes live in `cache-control.ts`. It respects the Anthropic ≤4
 * breakpoint invariant and avoids empty content blocks.
 */

import type { Message, Tool } from "../types.js";
import type {
  CacheControlOptions,
  CacheControlPlan,
  CacheTtl,
  CompactionMessage,
} from "./types.js";
import {
  attachMessageCacheControl,
  attachToolCacheControl,
  createCacheControl,
  isAnthropicProvider,
  stripCacheControl,
} from "./cache-control.js";

export const DEFAULT_CACHE_TTL: CacheTtl = "1h";
export const MAX_BREAKPOINTS = 4;

const TTL_MS: Record<CacheTtl, number> = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

function isCacheableMessage(message: Message): boolean {
  if (message.role === "system") return true;
  if (message.role === "user" || message.role === "assistant") {
    const content = message.content ?? "";
    if (typeof content === "string" && content.trim().length === 0) return false;
    return true;
  }
  return false;
}

/**
 * Build a cache plan with at most `MAX_BREAKPOINTS` breakpoints.
 *
 * Strategy `system_and_2` (default):
 *   1. static system prefix marker (when provided)
 *   2. full system-prompt marker
 *   3. last cacheable non-system message
 *   4. second-to-last cacheable non-system message
 *
 * Falls back to `system_and_3` when fewer than two non-system cacheable
 * messages exist. Tool breakpoints are only emitted for Anthropic-compatible
 * providers and count toward the limit.
 */
export function buildPromptCachePlan(
  messages: Message[],
  options: CacheControlOptions,
): CacheControlPlan {
  const provider = options.provider;
  const ttlMs = options.cacheTtl ? TTL_MS[options.cacheTtl] : TTL_MS[DEFAULT_CACHE_TTL];

  if (!isAnthropicProvider(provider)) {
    return {
      messageBreakpoints: [],
      toolBreakpoints: [],
      breakpointCount: 0,
      ttlMs,
    };
  }

  const messageBreakpoints: number[] = [];

  // 1. Static system prefix marker (stable across sessions).
  if (options.staticSystemPrefix && options.staticSystemPrefix.trim().length > 0) {
    messageBreakpoints.push(0);
  }

  // 2. Full system prompt marker — find the latest system message.
  let systemIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "system") {
      systemIndex = i;
      break;
    }
  }
  if (systemIndex >= 0 && !messageBreakpoints.includes(systemIndex)) {
    messageBreakpoints.push(systemIndex);
  }

  // 3/4. Last cacheable non-system messages.
  const nonSystemIndexes: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "system" && isCacheableMessage(messages[i] as Message)) {
      if (!messageBreakpoints.includes(i)) {
        nonSystemIndexes.push(i);
      }
      if (nonSystemIndexes.length >= 2) break;
    }
  }

  // If we have room, include the second-to-last message before the last one.
  if (nonSystemIndexes.length >= 2) {
    messageBreakpoints.push(nonSystemIndexes[1] as number);
  }
  if (nonSystemIndexes.length >= 1) {
    messageBreakpoints.push(nonSystemIndexes[0] as number);
  }

  // Tool breakpoints are reserved for Anthropic native direct tool cache.
  // We keep one slot for the last tool when a tool cache is requested, but
  // by default we only cache messages to stay under the 4-breakpoint budget.
  const toolBreakpoints: number[] = [];

  // Trim to MAX_BREAKPOINTS while preserving earlier (more stable) markers.
  const trimmedBreakpoints = messageBreakpoints.slice(0, MAX_BREAKPOINTS);

  return {
    messageBreakpoints: trimmedBreakpoints,
    toolBreakpoints,
    breakpointCount: trimmedBreakpoints.length + toolBreakpoints.length,
    ttlMs,
  };
}

/**
 * Apply a cache plan to message and tool arrays. Always returns shallow copies
 * so the canonical history remains untouched.
 */
export function applyCacheControl(
  messages: CompactionMessage[],
  tools: Tool[],
  plan: CacheControlPlan,
  options: CacheControlOptions,
): { messages: CompactionMessage[]; tools: Tool[] } {
  const provider = options.provider;
  if (!isAnthropicProvider(provider) || plan.breakpointCount === 0) {
    return { messages: [...messages], tools: [...tools] };
  }

  const applied = new Set<number>();
  const outMessages = messages.map((m, idx) => {
    if (plan.messageBreakpoints.includes(idx) && !applied.has(idx)) {
      applied.add(idx);
      return attachMessageCacheControl(m, provider);
    }
    return { ...m };
  });

  const outTools = tools.map((t, idx) => {
    if (plan.toolBreakpoints.includes(idx)) {
      return attachToolCacheControl(t, provider);
    }
    return { ...t };
  });

  return { messages: outMessages, tools: outTools };
}

/**
 * Convenience helper: build a plan and apply it in one call.
 */
export function planAndApplyCacheControl(
  messages: CompactionMessage[],
  tools: Tool[],
  options: CacheControlOptions,
): { messages: CompactionMessage[]; tools: Tool[]; plan: CacheControlPlan } {
  const plan = buildPromptCachePlan(messages, options);
  const { messages: decoratedMessages, tools: decoratedTools } = applyCacheControl(messages, tools, plan, options);
  return { messages: decoratedMessages, tools: decoratedTools, plan };
}

/**
 * Build an opaque cache key for a set of messages + tools. Used to detect
 * identical prefixes across requests (and, with stable-prefix registry, across
 * sessions).
 */
export function buildCacheKey(messages: Message[], tools?: Tool[]): string {
  const payload = {
    messages: messages.map((m) => ({ role: m.role, content: m.content, tool_calls: m.toolCalls })),
    tools: (tools ?? []).map((t) => ({ name: t.name, description: t.description })),
  };
  return JSON.stringify(payload);
}

/**
 * Stable-prefix registry enabling cross-session prefix cache hits.
 *
 * Builders can register a stable system-prompt prefix (e.g. skills scaffolding)
 * so that the planner places the first breakpoint at byte-identical content.
 */
export interface StablePrefixEntry {
  prefix: string;
  registeredAt: number;
}

export interface StablePrefixRegistry {
  register(prefix: string): void;
  find(messages: Message[]): StablePrefixEntry | undefined;
  clear(): void;
}

export function createStablePrefixRegistry(maxEntries = 32, maxChars = 4 * 1024 * 1024): StablePrefixRegistry {
  const entries = new Map<string, StablePrefixEntry>();
  let charCount = 0;

  function evictIfNeeded(insertChars: number): void {
    if (entries.size === 0) return;
    while ((charCount + insertChars > maxChars || entries.size >= maxEntries) && entries.size > 0) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = entries.get(oldestKey);
      if (oldest) {
        charCount -= oldest.prefix.length;
      }
      entries.delete(oldestKey);
    }
  }

  return {
    register(prefix: string): void {
      if (prefix.length === 0) return;
      evictIfNeeded(prefix.length);
      const key = prefix.slice(0, 256);
      if (entries.has(key)) {
        charCount -= (entries.get(key) as StablePrefixEntry).prefix.length;
      }
      entries.set(key, { prefix, registeredAt: Date.now() });
      charCount += prefix.length;
    },
    find(messages: Message[]): StablePrefixEntry | undefined {
      if (messages.length === 0) return undefined;
      const first = messages[0];
      if (first?.role !== "system") return undefined;
      const text = typeof first.content === "string" ? first.content : "";
      for (const entry of entries.values()) {
        if (text.startsWith(entry.prefix)) return entry;
      }
      return undefined;
    },
    clear(): void {
      entries.clear();
      charCount = 0;
    },
  };
}

export { createCacheControl, isAnthropicProvider, stripCacheControl };
