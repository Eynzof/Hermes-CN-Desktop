/**
 * Per-tool token estimation for the checklist status line.
 *
 * Mirrors Python `tiktoken` cl100k_base counts via `js-tiktoken`; falls back to
 * `chars / 4` when the encoder is not available.
 */

import { getEncoding } from "js-tiktoken";
import type { ToolDefinition } from "./types.js";

function fallbackCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function countTokens(text: string): Promise<number> {
  try {
    const enc = getEncoding("cl100k_base");
    return enc.encode(text).length;
  } catch {
    return fallbackCount(text);
  }
}

/** Estimate tokens for a single OpenAI-format tool definition. */
export async function estimateToolTokens(def: ToolDefinition): Promise<number> {
  const text = [
    def.function.name,
    def.function.description,
    JSON.stringify(def.function.parameters),
  ].join("\n");
  return countTokens(text);
}

/** Estimate total tokens for a list of tool definitions. */
export async function estimateToolSetTokens(defs: ToolDefinition[]): Promise<number> {
  let total = 0;
  for (const d of defs) {
    total += await estimateToolTokens(d);
  }
  return total;
}

/** Synchronous chars/4 fallback for UI render paths that cannot await wasm. */
export function estimateToolSetTokensSync(defs: ToolDefinition[]): number {
  let total = 0;
  for (const d of defs) {
    const text = [
      d.function.name,
      d.function.description,
      JSON.stringify(d.function.parameters),
    ].join("\n");
    total += fallbackCount(text);
  }
  return total;
}
