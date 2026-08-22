/**
 * x_search runtime config loader.
 */

import { fetchJSON } from "@/lib/transport.js";
import { runtime } from "@/lib/runtime.js";
import type { XaiConfig } from "./types.js";

const TEST_CONFIG_KEY = "__HERMES_X_SEARCH_CONFIG__";

function readGlobal<T>(key: string): T | undefined {
  return (globalThis as Record<string, unknown>)[key] as T | undefined;
}

function writeGlobal<T>(key: string, value: T | null): void {
  (globalThis as Record<string, unknown>)[key] = value;
}

let cached: XaiConfig | null = null;
let cachedAt = 0;
const TTL_MS = 5_000;

export async function loadXaiConfig(): Promise<XaiConfig> {
  const override = readGlobal<XaiConfig>(TEST_CONFIG_KEY);
  if (override) {
    return override;
  }

  const now = Date.now();
  if (cached && now - cachedAt < TTL_MS) return cached;

  if (!runtime.isBackendReady()) {
    return { model: "grok-4.5", timeout_seconds: 180, retries: 2 };
  }

  try {
    const cfg = (await fetchJSON("/api/config")) as Record<string, unknown>;
    const xs = (cfg?.x_search ?? {}) as Record<string, unknown>;
    cached = {
      model: typeof xs.model === "string" ? xs.model : "grok-4.5",
      reasoning_effort: ["low", "medium", "high", "xhigh"].includes(xs.reasoning_effort as string)
        ? (xs.reasoning_effort as "low" | "medium" | "high" | "xhigh")
        : undefined,
      timeout_seconds: typeof xs.timeout_seconds === "number" ? xs.timeout_seconds : 180,
      retries: typeof xs.retries === "number" ? xs.retries : 2,
    };
    cachedAt = now;
    return cached;
  } catch {
    return { model: "grok-4.5", timeout_seconds: 180, retries: 2 };
  }
}

export function resetXaiConfigCache(): void {
  cached = null;
  cachedAt = 0;
}

export function setXaiConfigForTest(config: XaiConfig | null): void {
  writeGlobal(TEST_CONFIG_KEY, config);
}