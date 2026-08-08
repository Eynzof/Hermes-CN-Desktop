// Update download source configuration (`update-config.json`).
//
// Mirrors `src/update_config.rs`. One JSON file in the desktop data directory
// controls where the unified self-update flow downloads from. The cascade is
// file > `HERMES_UPDATE_*` env > baked defaults > hardcoded fallback.

import type { UpdateConfig, UpdateConfigSnapshot } from "@hermes/protocol";

export const DEFAULT_RELEASE_MANIFEST_URL = "https://desktop.hermesagent.org.cn/latest.json";
export const DEFAULT_RUNTIME_BASE_URL = "https://desktop.hermesagent.org.cn/runtime";
export const DEFAULT_UPDATE_CHANNEL = "stable";
export const DEFAULT_UPDATE_TIMEOUT_SECONDS = 10;
export const UPDATE_CHANNELS = ["stable", "beta", "canary"] as const;

export function defaultUpdateConfig(): UpdateConfig {
  return {
    schemaVersion: 1,
    channel: DEFAULT_UPDATE_CHANNEL,
    releaseManifestUrl: DEFAULT_RELEASE_MANIFEST_URL,
    runtimeBaseUrl: DEFAULT_RUNTIME_BASE_URL,
    runtimeManifestUrl: "",
    runtimePublicKeyPem: "",
    timeoutSeconds: DEFAULT_UPDATE_TIMEOUT_SECONDS,
    verifySha256: true,
    verifySignature: true,
    mirrors: [],
  };
}

export function normalizeUpdateConfig(input: unknown): UpdateConfig {
  const fallback = defaultUpdateConfig();
  if (!input || typeof input !== "object") return fallback;
  const raw = input as Record<string, unknown>;
  return {
    schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : fallback.schemaVersion,
    channel: typeof raw.channel === "string" && raw.channel.trim() ? raw.channel : fallback.channel,
    releaseManifestUrl:
      typeof raw.releaseManifestUrl === "string" && raw.releaseManifestUrl.trim()
        ? raw.releaseManifestUrl
        : fallback.releaseManifestUrl,
    runtimeBaseUrl:
      typeof raw.runtimeBaseUrl === "string" && raw.runtimeBaseUrl.trim()
        ? raw.runtimeBaseUrl
        : fallback.runtimeBaseUrl,
    runtimeManifestUrl:
      typeof raw.runtimeManifestUrl === "string" ? raw.runtimeManifestUrl : "",
    runtimePublicKeyPem:
      typeof raw.runtimePublicKeyPem === "string" ? raw.runtimePublicKeyPem : "",
    timeoutSeconds:
      typeof raw.timeoutSeconds === "number" && raw.timeoutSeconds > 0
        ? raw.timeoutSeconds
        : fallback.timeoutSeconds,
    verifySha256:
      typeof raw.verifySha256 === "boolean" ? raw.verifySha256 : fallback.verifySha256,
    verifySignature:
      typeof raw.verifySignature === "boolean" ? raw.verifySignature : fallback.verifySignature,
    mirrors: Array.isArray(raw.mirrors)
      ? raw.mirrors.filter((m): m is { label: string; releaseManifestUrl: string; runtimeBaseUrl: string } =>
          Boolean(m && typeof m === "object"),
        )
      : [],
  };
}

/** Validate before persisting — mirrors the Rust-side validation rules. */
export function validateUpdateConfig(config: UpdateConfig): string | null {
  if (!UPDATE_CHANNELS.includes(config.channel as (typeof UPDATE_CHANNELS)[number])) {
    return `channel 必须是 ${UPDATE_CHANNELS.join(" / ")} 之一，当前是 ${config.channel}`;
  }
  for (const [label, value] of [
    ["releaseManifestUrl", config.releaseManifestUrl],
    ["runtimeBaseUrl", config.runtimeBaseUrl],
    ["runtimeManifestUrl", config.runtimeManifestUrl],
  ] as const) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (!/^https:\/\//i.test(trimmed)) {
      return `${label} 必须是 https 地址`;
    }
  }
  if (config.timeoutSeconds < 1 || config.timeoutSeconds > 300) {
    return `timeoutSeconds 必须在 1–300 秒之间，当前是 ${config.timeoutSeconds}`;
  }
  return null;
}

export function hasUpdateConfigBridge(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.hermesDesktop?.getUpdateConfig && window.hermesDesktop?.setUpdateConfig)
  );
}

export async function getUpdateConfig(): Promise<UpdateConfigSnapshot> {
  if (!window.hermesDesktop?.getUpdateConfig) {
    throw new Error("当前环境没有更新源配置能力");
  }
  return window.hermesDesktop.getUpdateConfig();
}

export async function setUpdateConfig(config: UpdateConfig): Promise<UpdateConfigSnapshot> {
  const error = validateUpdateConfig(config);
  if (error) throw new Error(error);
  if (!window.hermesDesktop?.setUpdateConfig) {
    throw new Error("当前环境没有更新源配置能力");
  }
  return window.hermesDesktop.setUpdateConfig(config);
}
