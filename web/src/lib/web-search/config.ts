/**
 * Lightweight config loader for the web search/extract toolset.
 * Reads the `web:` section from the dashboard config and merges environment
 * overrides passed through the tool context.
 */

import { fetchJSON } from "@/lib/transport.js";
import { runtime } from "@/lib/runtime.js";
import type { ToolContext } from "@hermes/agent-tools";
import type { WebConfig, ProviderEnv } from "./types.js";

const TEST_CONFIG_KEY = "__HERMES_WEB_CONFIG__";
const TEST_ENV_KEY = "__HERMES_WEB_ENV__";

function readGlobal<T>(key: string): T | undefined {
  return (globalThis as Record<string, unknown>)[key] as T | undefined;
}

function writeGlobal<T>(key: string, value: T | null): void {
  (globalThis as Record<string, unknown>)[key] = value;
}

let cachedConfig: WebConfig | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5_000;

export function getWebEnv(ctx?: ToolContext): ProviderEnv {
  const base: ProviderEnv = {};
  const envOverride = readGlobal<ProviderEnv>(TEST_ENV_KEY);
  if (envOverride) {
    Object.assign(base, envOverride);
  }
  if (ctx?.env) {
    Object.assign(base, ctx.env);
  }
  return base;
}

export async function loadWebConfig(): Promise<WebConfig> {
  const override = readGlobal<WebConfig>(TEST_CONFIG_KEY);
  if (override) {
    return override;
  }

  const now = Date.now();
  if (cachedConfig && now - cachedAt < CACHE_TTL_MS) {
    return cachedConfig;
  }

  if (!runtime.isBackendReady()) {
    return {};
  }

  try {
    const cfg = (await fetchJSON("/api/config")) as Record<string, unknown>;
    const web = (cfg?.web ?? {}) as WebConfig;
    cachedConfig = web;
    cachedAt = now;
    return web;
  } catch {
    return {};
  }
}

export function resetWebConfigCache(): void {
  cachedConfig = null;
  cachedAt = 0;
}

export function setWebConfigForTest(config: WebConfig | null): void {
  writeGlobal(TEST_CONFIG_KEY, config);
}

export function setWebEnvForTest(env: ProviderEnv | null): void {
  writeGlobal(TEST_ENV_KEY, env);
}