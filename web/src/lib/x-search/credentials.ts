/**
 * Resolve xAI bearer credentials: OAuth first (out of scope for MVP), then
 * XAI_API_KEY from the tool context / global env override.
 */

import type { ToolContext } from "@hermes/agent-tools";

export interface XaiCredentials {
  bearer: string;
  source: "xai" | "xai-oauth";
  baseUrl: string;
}

const TEST_CREDENTIALS_KEY = "__HERMES_XAI_CREDENTIALS__";

function readGlobal<T>(key: string): T | undefined {
  return (globalThis as Record<string, unknown>)[key] as T | undefined;
}

function writeGlobal<T>(key: string, value: T | null): void {
  (globalThis as Record<string, unknown>)[key] = value;
}

export function resolveXaiCredentials(ctx?: ToolContext): XaiCredentials | null {
  const override = readGlobal<XaiCredentials>(TEST_CREDENTIALS_KEY);
  if (override) {
    return override;
  }

  const env = ctx?.env ?? {};
  const baseUrl = (env.XAI_BASE_URL ?? "https://api.x.ai/v1").trim();
  const key = env.XAI_API_KEY?.trim();
  if (key) {
    return { bearer: key, source: "xai", baseUrl };
  }
  return null;
}

export function hasXaiCredentials(ctx?: ToolContext): boolean {
  return resolveXaiCredentials(ctx) !== null;
}

export function setXaiCredentialsForTest(creds: XaiCredentials | null): void {
  writeGlobal(TEST_CREDENTIALS_KEY, creds);
}