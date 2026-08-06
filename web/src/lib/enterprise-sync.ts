// HuanXing-Team（默认 :3100）WorkBuddy 模型下发 client。
//
// 协议（来自 Team 后端调研）：设备端拉取
//   GET {serverUrl}/api/workbuddy/sync
//   Authorization: Bearer <deviceToken>
// 响应 data：{ cleanupOnly?, models: [...], defaultModel?, skills? }。
// 每个模型的 url 指向 Team proxy（{serverUrl}/api/workbuddy/proxy/v1），
// OpenAI 模型走 Chat Completions，Anthropic 模型走 Messages；apiKey 即
// deviceToken 本身，真实上游 key 永不下发。
// 设备被停用时返回 cleanupOnly:true + 空清单，客户端据此清理本地托管模型。
//
// 应用策略：下发的模型写成 Core config.yaml 里的自定义 provider
//（id 前缀 custom:team-），这样它们自动出现在 Composer 的模型选择器里，
// 并通过 Core 对应的 OpenAI / Anthropic 兼容通道真实可用。

import { readUiValue, removeUiValue, writeUiValue } from "./ui-store";
import { BRAND } from "./brand.generated";

export const DEFAULT_TEAM_SERVER_URL = BRAND.teamServiceUrl;
export const ENTERPRISE_PROVIDER_PREFIX = "custom:team-";

export function deviceTokenManagementUrl(serverUrl = DEFAULT_TEAM_SERVER_URL): string {
  return `${serverUrl.trim().replace(/\/+$/, "")}/workbuddy`;
}

export interface EnterpriseBinding {
  serverUrl: string;
  deviceToken: string;
}

export interface EnterpriseModel {
  id: string;
  name?: string;
  vendor?: string;
  url?: string;
  modelType?: string;
  tags?: string[];
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  useCustomProtocol?: boolean;
  maxInputTokens?: number;
}

export interface EnterpriseSyncData {
  cleanupOnly?: boolean;
  models?: EnterpriseModel[];
  defaultModel?: string;
  skills?: unknown[];
}

export interface EnterpriseSyncMeta {
  lastSyncAt: number;
  modelCount: number;
  defaultModel?: string;
  cleanupOnly?: boolean;
}

const BINDING_KEY = "hermes.enterprise-binding";
const SYNC_META_KEY = "hermes.enterprise-sync-meta";

export function readEnterpriseBinding(): EnterpriseBinding | null {
  const value = readUiValue<EnterpriseBinding | null>(BINDING_KEY, null);
  if (!value || typeof value !== "object") return null;
  if (typeof value.serverUrl !== "string" || !value.serverUrl.trim()) return null;
  if (typeof value.deviceToken !== "string" || !value.deviceToken.trim()) return null;
  return value;
}

export function writeEnterpriseBinding(binding: EnterpriseBinding | null): void {
  if (binding) writeUiValue(BINDING_KEY, binding);
  else removeUiValue(BINDING_KEY);
}

export function readEnterpriseSyncMeta(): EnterpriseSyncMeta | null {
  const value = readUiValue<EnterpriseSyncMeta | null>(SYNC_META_KEY, null);
  if (!value || typeof value !== "object" || typeof value.lastSyncAt !== "number") return null;
  return value;
}

export function writeEnterpriseSyncMeta(meta: EnterpriseSyncMeta | null): void {
  if (meta) writeUiValue(SYNC_META_KEY, meta);
  else removeUiValue(SYNC_META_KEY);
}

export function enterpriseProviderId(workbuddyId: string): string {
  return `${ENTERPRISE_PROVIDER_PREFIX}${workbuddyId}`;
}

function usesAnthropicMessages(model: EnterpriseModel): boolean {
  if (model.useCustomProtocol === true) return true;
  const id = model.id.trim().toLowerCase();
  // Older Team manifests did not include useCustomProtocol. Keep the
  // account-era routing for the two branded aliases that are Messages-only.
  return id === "claude-opus-4-8" || id === "kimi-k3";
}

function anthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

interface SyncEnvelope {
  success: boolean;
  message?: string;
  data?: EnterpriseSyncData;
}

/** 拉取下发清单（走 Rust IPC 代理，绕开 webview CORS 限制）。 */
export async function syncEnterpriseModels(binding: EnterpriseBinding): Promise<EnterpriseSyncData> {
  const bridge = typeof window !== "undefined" ? window.hermesDesktop : undefined;
  if (!bridge?.externalRequest) {
    throw new Error("当前运行环境不支持外部请求（需要桌面端 IPC 代理）");
  }
  const base = binding.serverUrl.trim().replace(/\/+$/, "");
  const result = await bridge.externalRequest({
    path: `${base}/api/workbuddy/sync`,
    method: "GET",
    headers: { Authorization: `Bearer ${binding.deviceToken.trim()}` },
    body: null,
  });
  let envelope: SyncEnvelope | null = null;
  try {
    envelope = result.body ? (JSON.parse(result.body) as SyncEnvelope) : null;
  } catch {
    envelope = null;
  }
  if (!result.ok) {
    throw new Error(envelope?.message || `同步失败（HTTP ${result.status}）`);
  }
  if (!envelope || envelope.success !== true) {
    throw new Error(envelope?.message || "同步失败：设备令牌无效或已被停用");
  }
  return envelope.data ?? {};
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

/**
 * 把下发清单应用到 Core config（纯函数，可单测）：
 * - cleanupOnly → 删除全部 custom:team-* providers；
 * - 否则 upsert 清单内模型、删除已不在清单里的 team providers；
 * - defaultModel 在清单内时写回 model.{provider, default, ...} 使其成为当前模型。
 * 不会触碰非 team 前缀的自定义 provider。
 */
export function applyEnterpriseSync(
  config: Record<string, any>,
  binding: EnterpriseBinding,
  data: EnterpriseSyncData,
): Record<string, any> {
  const base = binding.serverUrl.trim().replace(/\/+$/, "");
  const providers = { ...asRecord(config.providers) };
  for (const key of Object.keys(providers)) {
    if (key.startsWith(ENTERPRISE_PROVIDER_PREFIX)) delete providers[key];
  }

  const models = data.cleanupOnly ? [] : (data.models ?? []);
  for (const model of models) {
    if (!model?.id) continue;
    const providerId = enterpriseProviderId(model.id);
    const anthropic = usesAnthropicMessages(model);
    const baseUrl = model.url || `${base}/api/workbuddy/proxy/v1`;
    providers[providerId] = {
      name: model.name || model.id,
      // Anthropic's SDK appends /v1/messages itself. The Team proxy URL is
      // advertised with a /v1 suffix for OpenAI clients, so strip it here to
      // avoid producing /v1/v1/messages.
      base_url: anthropic ? anthropicBaseUrl(baseUrl) : baseUrl,
      api_mode: anthropic ? "anthropic_messages" : "chat_completions",
      transport: anthropic ? "anthropic_messages" : "openai_chat",
      // The manifest is authoritative. Do not probe /models and replace the
      // explicitly synchronized model with an unrelated relay catalog.
      discover_models: false,
      api_key: binding.deviceToken.trim(),
      model: model.id,
      models: {
        [model.id]: {
          ...(model.maxInputTokens ? { context_length: model.maxInputTokens } : {}),
          supports_tools: model.supportsToolCall ?? true,
          supports_vision: model.supportsImages ?? false,
          supports_reasoning: model.supportsReasoning ?? false,
        },
      },
    };
  }

  const next: Record<string, any> = { ...config, providers };
  const defaultModel = data.cleanupOnly ? undefined : data.defaultModel;
  if (defaultModel && models.some((model) => model.id === defaultModel)) {
    const providerId = enterpriseProviderId(defaultModel);
    const provider = asRecord(providers[providerId]);
    next.model = {
      ...asRecord(config.model),
      provider: providerId,
      default: defaultModel,
      base_url: provider.base_url,
      api_mode: provider.api_mode,
      api_key: binding.deviceToken.trim(),
    };
  }
  return next;
}
