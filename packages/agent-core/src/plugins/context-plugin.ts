/**
 * Context-engine plugin adapter.
 *
 * Context-engine plugins provide alternative strategies for compressing or
 * summarizing conversation context. The registry keeps one active engine
 * (mirroring Python's exclusive `context.engine` config key, default
 * "compressor") while still exposing all discovered engines to the UI.
 */

import type { Message } from "../types.js";
import type { PluginManifest } from "./types.js";

/** A context engine that can compress a message list. */
export interface ContextEngine {
  /** Engine slug (e.g. "compressor", "rolling-summary"). */
  slug: string;
  /** Display name. */
  name: string;
  /** One-line description. */
  description?: string;
  /**
   * Compress a list of messages into a shorter representation.
   * Returns undefined to indicate the engine chose not to compress.
   */
  compress(messages: Message[], options?: { budget?: number }): Promise<CompressionResult | undefined>;
}

/** Result of a context compression. */
export interface CompressionResult {
  /** Compressed messages that replace the input. */
  messages: Message[];
  /** Human-readable summary for logging / UI. */
  summary?: string;
  /** Tokens saved, if known. */
  tokensSaved?: number;
}

const engines = new Map<string, ContextEngine>();
let activeSlug: string | undefined = undefined;

/** Register a context-engine plugin. */
export function registerContextEngine(engine: ContextEngine): void {
  engines.set(engine.slug, engine);
  if (activeSlug === undefined) {
    activeSlug = engine.slug;
  }
}

/** Get a registered context engine by slug. */
export function getContextEngine(slug: string): ContextEngine | undefined {
  return engines.get(slug);
}

/** List all registered context engines. */
export function listContextEngines(): ContextEngine[] {
  return Array.from(engines.values()).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Unregister a context engine. */
export function unregisterContextEngine(slug: string): boolean {
  const removed = engines.delete(slug);
  if (activeSlug === slug) {
    activeSlug = engines.keys().next().value as string | undefined ?? undefined;
  }
  return removed;
}

/** Clear every registered context engine. */
export function clearContextEngines(): void {
  engines.clear();
  activeSlug = undefined;
}

/** Set the active context engine. */
export function setActiveContextEngine(slug: string): boolean {
  if (!engines.has(slug)) return false;
  activeSlug = slug;
  return true;
}

/** Get the active context engine slug. */
export function getActiveContextEngine(): string | undefined {
  return activeSlug;
}

/** Compress a message list using the active context engine. */
export async function compressWithActiveEngine(
  messages: Message[],
  options?: { budget?: number },
): Promise<CompressionResult | undefined> {
  const engine = engines.get(activeSlug ?? "");
  if (!engine) return undefined;
  return engine.compress(messages, options);
}

/** Build a context-engine plugin record from a manifest and implementation. */
export function manifestToContextEngine(
  manifest: PluginManifest,
  compress: ContextEngine["compress"],
): ContextEngine {
  return {
    slug: manifest.name,
    name: manifest.title ?? manifest.name,
    description: manifest.description,
    compress,
  };
}
