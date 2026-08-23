// Update download source configuration (`update-config.json`).
//
// Mirrors `src/update_config.rs`. One JSON file in the desktop data directory
// controls where the unified self-update flow downloads from. The cascade is
// file > `HERMES_UPDATE_*` env > baked defaults > hardcoded fallback.

import type {
  ImportUpdateInvitationInput,
  UpdateConfig,
  UpdateConfigSnapshot,
  UpdateCredentialStatus,
} from "@hermes/protocol";

export const DEFAULT_RELEASE_MANIFEST_URL = "https://desktop.hermesagent.org.cn/latest.json";
export const DEFAULT_RUNTIME_BASE_URL = "https://desktop.hermesagent.org.cn/runtime";
export const DEFAULT_UPDATE_CHANNEL = "stable";
export const DEFAULT_UPDATE_TIMEOUT_SECONDS = 10;
export const UPDATE_CHANNELS = ["stable", "beta", "canary", "prototype"] as const;

export function defaultUpdateConfig(): UpdateConfig {
  return {
    schemaVersion: 2,
    channel: DEFAULT_UPDATE_CHANNEL,
    deviceId: "",
    shellUpdaterEndpoint: "",
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
    deviceId: typeof raw.deviceId === "string" ? raw.deviceId : "",
    shellUpdaterEndpoint:
      typeof raw.shellUpdaterEndpoint === "string" ? raw.shellUpdaterEndpoint : "",
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
  if (config.deviceId.length > 128 || !/^[0-9A-Za-z._-]*$/.test(config.deviceId)) {
    return "deviceId 只能包含最多 128 个字母、数字、点、下划线和连字符";
  }
  if (config.shellUpdaterEndpoint.trim()) {
    try {
      const endpoint = new URL(config.shellUpdaterEndpoint.trim());
      const controlHosts = new Set([
        "hot-update-staging.hermesagent.org.cn",
        "hot-update.hermesagent.org.cn",
      ]);
      const segments = endpoint.pathname.split("/").filter(Boolean);
      if (
        endpoint.protocol !== "https:" ||
        !controlHosts.has(endpoint.hostname) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        segments.length !== 6 ||
        segments[0] !== "v1" ||
        segments[1] !== "check"
      ) {
        return "shellUpdaterEndpoint 必须是 Hermes Cloudflare 控制域名的完整 /v1/check https 模板";
      }
    } catch {
      return "shellUpdaterEndpoint 不是有效 URL";
    }
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

export function parseUpdateInvitation(text: string): ImportUpdateInvitationInput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("邀请配置不是有效 JSON");
  }
  if (!value || typeof value !== "object") throw new Error("邀请配置必须是 JSON 对象");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw new Error("邀请配置 schemaVersion 必须为 1");
  if (!(["prototype", "canary", "beta"] as readonly unknown[]).includes(raw.channel)) {
    throw new Error("邀请配置 channel 必须是 prototype / canary / beta");
  }
  for (const field of ["endpoint", "deviceId", "token"] as const) {
    if (typeof raw[field] !== "string" || !raw[field].trim()) {
      throw new Error(`邀请配置缺少 ${field}`);
    }
  }
  return {
    schemaVersion: 1,
    endpoint: String(raw.endpoint).trim(),
    channel: raw.channel as ImportUpdateInvitationInput["channel"],
    deviceId: String(raw.deviceId).trim(),
    token: String(raw.token).trim(),
  };
}

export async function importUpdateInvitation(text: string): Promise<UpdateConfigSnapshot> {
  if (!window.hermesDesktop?.importUpdateInvitation) {
    throw new Error("当前环境没有系统凭据导入能力");
  }
  return window.hermesDesktop.importUpdateInvitation(parseUpdateInvitation(text));
}

export async function getUpdateCredentialStatus(): Promise<UpdateCredentialStatus> {
  if (!window.hermesDesktop?.getUpdateCredentialStatus) {
    throw new Error("当前环境没有系统凭据状态能力");
  }
  return window.hermesDesktop.getUpdateCredentialStatus();
}
