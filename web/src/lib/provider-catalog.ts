import { fetchExternalJSON } from "./transport";

export type ProviderTransport = "openai_chat" | "anthropic_messages" | "codex_responses";
export type ProviderApiMode = "chat_completions" | "anthropic_messages" | "codex_responses";

export interface ProviderCatalogModel {
  id: string;
  label?: string;
  contextWindow?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
}

/**
 * Partner promotion slot: the config panel's "前往官网" button opens this URL
 * (it carries our invite/aff code). Referral links change far more often than
 * API endpoints, so they are expected to be updated through the remote
 * catalog (no app release needed).
 */
export interface ProviderPromotion {
  /** Referral link (carries our invite/aff code). Opened via openExternalUrl. */
  url: string;
  /** Badge on the preset card: partner = star, prime = heart. */
  badge?: "partner" | "prime";
}

export interface ProviderPreset {
  id: string;
  name: string;
  vendor: string;
  region: "cn" | "global";
  baseUrl: string;
  apiMode: ProviderApiMode;
  transport: ProviderTransport;
  apiKeyLabel: string;
  /** Backward-compatible env names that should still be recognized as saved credentials. */
  apiKeyAliases?: string[];
  docsUrl?: string;
  /** Provider homepage (may carry a referral code). */
  websiteUrl?: string;
  /** Key into the provider icon registry; falls back to an initial-letter tile. */
  icon?: string;
  promotion?: ProviderPromotion;
  defaultModel: string;
  models: ProviderCatalogModel[];
  supportsModelListing?: boolean;
  /** True when this preset was added by the user at runtime (custom OpenAI-compat entry). */
  isCustom?: boolean;
}

export interface ProviderCatalog {
  version: string;
  providers: ProviderPreset[];
}

/**
 * 用户可读的接口格式名。目录里 Claude Code 中转与 OpenAI 兼容服务混排，
 * 界面必须把请求格式讲明白，用户才知道一个供应商到底按什么协议被请求。
 */
export function apiModeDisplayName(apiMode: ProviderApiMode): string {
  switch (apiMode) {
    case "anthropic_messages":
      return "Anthropic 格式 (Claude Code)";
    case "codex_responses":
      return "OpenAI Responses 格式";
    default:
      return "OpenAI 兼容格式";
  }
}

/** 预设卡片上的协议角标；OpenAI 兼容是默认格式，不标注以降噪。 */
export function apiModeBadgeLabel(apiMode: ProviderApiMode): string | null {
  switch (apiMode) {
    case "anthropic_messages":
      return "Claude";
    case "codex_responses":
      return "Codex";
    default:
      return null;
  }
}

/**
 * 该供应商实际会收到请求的完整端点。Base URL 的语义随格式变化（Anthropic
 * SDK 自动补 /v1/messages，OpenAI SDK 补 /chat/completions），直接把最终
 * URL 摆出来比解释规则更防呆。
 */
export function chatEndpointPreviewUrl(apiMode: ProviderApiMode, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return "";
  switch (apiMode) {
    case "anthropic_messages":
      return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
    case "codex_responses":
      return `${base}/responses`;
    default:
      return `${base}/chat/completions`;
  }
}

/**
 * 自定义供应商 Base URL 的格式启发式，与 Core 端
 * runtime_provider._detect_api_mode_for_url 的中转站规则对齐：路径以
 * /anthropic 或 /anthropic/v1 结尾按 Anthropic 格式预选。
 */
export function detectCustomApiModeFromUrl(baseUrl: string): "chat_completions" | "anthropic_messages" {
  try {
    const path = new URL(baseUrl.trim()).pathname.replace(/\/+$/, "").toLowerCase();
    if (path.endsWith("/anthropic") || path.endsWith("/anthropic/v1")) return "anthropic_messages";
  } catch {
    // 输入中途的半截 URL —— 保持默认。
  }
  return "chat_completions";
}

export type EnvVarPreviewMap = Record<string, {
  is_set?: boolean;
  redacted_value?: string | null;
}>;

/**
 * Providers we feature first in the Chinese community edition. Any change to
 * this list reorders the Models tab list and the onboarding picker.
 */
export const TOP5_PROVIDER_IDS = [
  "deepseek",
  "minimax-cn",
  "kimi-for-coding",
  "alibaba",
] as const;

export type Top5ProviderId = (typeof TOP5_PROVIDER_IDS)[number];

const TOP5_INDEX: Record<string, number> = Object.fromEntries(
  TOP5_PROVIDER_IDS.map((id, index) => [id, index]),
);

/**
 * Three-tier ordering for the CN community edition: featured providers first
 * (in fixed order), then other CN providers (alphabetical), then everything else. Pure
 * function so it's safe to call in render and trivial to unit-test.
 */
export function sortProvidersForCnEdition(providers: ProviderPreset[]): ProviderPreset[] {
  return [...providers].sort((a, b) => {
    const aTop = TOP5_INDEX[a.id];
    const bTop = TOP5_INDEX[b.id];
    if (aTop != null && bTop != null) return aTop - bTop;
    if (aTop != null) return -1;
    if (bTop != null) return 1;
    if (a.region !== b.region) return a.region === "cn" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}

export function getProviderOrder(config: Record<string, any> | undefined): string[] {
  const desktop = asRecord(config?.desktop);
  const models = asRecord(desktop.models);
  const raw = models.provider_order;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const order: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order;
}

export function sortProvidersForModelsPage(
  providers: ProviderPreset[],
  config: Record<string, any> | undefined,
): ProviderPreset[] {
  const fallback = sortProvidersForCnEdition(providers);
  const byId = new Map(fallback.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const ordered: ProviderPreset[] = [];

  for (const id of getProviderOrder(config)) {
    const provider = byId.get(id);
    if (!provider || seen.has(id)) continue;
    seen.add(id);
    ordered.push(provider);
  }

  for (const provider of fallback) {
    if (seen.has(provider.id)) continue;
    ordered.push(provider);
  }

  return ordered;
}

export function buildProviderOrderUpdate(
  config: Record<string, any>,
  providerIds: string[],
): Record<string, any> {
  const desktop = asRecord(config.desktop);
  const models = asRecord(desktop.models);
  const seen = new Set<string>();
  const providerOrder = providerIds
    .map((id) => id.trim())
    .filter((id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

  return {
    ...config,
    desktop: {
      ...desktop,
      models: {
        ...models,
        provider_order: providerOrder,
      },
    },
  };
}

export function buildCustomProviderDeleteUpdate(
  config: Record<string, any>,
  providerId: string,
): Record<string, any> {
  if (!providerId.startsWith("custom:")) {
    throw new Error("只能删除用户添加的自定义服务商。");
  }

  const model = asRecord(config.model);
  if (String(model.provider || "") === providerId) {
    throw new Error("当前主模型正在使用此服务商，请先切换到其他模型后再删除。");
  }

  const providers = asRecord(config.providers);
  const nextProviders = { ...providers };
  delete nextProviders[providerId];

  let nextConfig = buildProviderOrderUpdate(
    {
      ...config,
      providers: nextProviders,
    },
    getProviderOrder(config).filter((id) => id !== providerId),
  );

  const auxiliary = asRecord(nextConfig.auxiliary);
  let auxiliaryChanged = false;
  const nextAuxiliary: Record<string, any> = {};
  for (const [task, rawSlot] of Object.entries(auxiliary)) {
    const slot = asRecord(rawSlot);
    if (String(slot.provider || "") !== providerId) {
      nextAuxiliary[task] = rawSlot;
      continue;
    }
    const nextSlot: Record<string, any> = {
      ...slot,
      provider: "auto",
      model: "",
      base_url: "",
      extra_body: {},
    };
    delete nextSlot.api_key;
    nextAuxiliary[task] = nextSlot;
    auxiliaryChanged = true;
  }

  if (auxiliaryChanged) {
    nextConfig = {
      ...nextConfig,
      auxiliary: nextAuxiliary,
    };
  }

  return nextConfig;
}

export interface ProviderConfigInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  // 用户手填的上下文窗口覆盖（token）。空串 / "0" / 非法值 = 自动探测。
  // 仅在「设为当前模型」路径落盘为顶层 model_context_length 字段。
  contextWindow?: string;
}

/**
 * 把用户在输入框里填的上下文窗口字符串解析成后端要的整数。
 * 空串 / 非数字 / 负数 → 0（= 让后端自动探测）；小数向下取整。
 */
export function parseContextWindowInput(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

export const BUILTIN_PROVIDER_CATALOG_VERSION = "2026.07.11.1";

export const BUILTIN_PROVIDER_CATALOG: ProviderCatalog = {
  version: BUILTIN_PROVIDER_CATALOG_VERSION,
  providers: [
    {
      id: "cp.compshare.cn",
      name: "优云智算 · Agent Plan",
      vendor: "优云智算 (Compshare)",
      region: "cn",
      baseUrl: "https://cp.compshare.cn/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "COMPSHARE_API_KEY",
      icon: "compshare",
      docsUrl: "https://www.compshare.cn/",
      websiteUrl: "https://www.compshare.cn/",
      promotion: {
        url: "https://passport.compshare.cn/register?referral_code=K50gMvv85OmEJ5T9ZDUtDE&ytag=GPU_YY_YX_hermesagent.org.cn",
        badge: "partner",
      },
      defaultModel: "deepseek-v4-flash",
      models: [
        { id: "deepseek-v4-flash", supportsTools: true },
      ],
      supportsModelListing: false,
    },
    {
      id: "modelverse",
      name: "优云智算 · API 按量付费",
      vendor: "优云智算 (Compshare)",
      region: "cn",
      baseUrl: "https://api.modelverse.cn/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "COMPSHARE_API_KEY",
      icon: "compshare",
      docsUrl: "https://www.compshare.cn/",
      websiteUrl: "https://www.compshare.cn/",
      promotion: {
        url: "https://passport.compshare.cn/register?referral_code=K50gMvv85OmEJ5T9ZDUtDE&ytag=GPU_YY_YX_hermesagent.org.cn",
        badge: "partner",
      },
      defaultModel: "deepseek-v4-flash",
      models: [
        { id: "deepseek-v4-flash", supportsTools: true },
      ],
    },
    {
      id: "alibaba",
      name: "阿里云百炼 · API 按量付费",
      vendor: "Alibaba Cloud",
      region: "cn",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "DASHSCOPE_API_KEY",
      icon: "bailian",
      websiteUrl: "https://bailian.console.aliyun.com",
      docsUrl: "https://help.aliyun.com/zh/model-studio/",
      defaultModel: "qwen3-coder-plus",
      models: [
        { id: "qwen3-coder-plus", supportsTools: true, supportsReasoning: true },
        { id: "qwen3.7-max", supportsTools: true, supportsReasoning: true },
        { id: "qwen3.7-plus", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "qwen3-max", supportsTools: true, supportsReasoning: true },
        { id: "qwen-plus", supportsTools: true },
        { id: "qwen-max", supportsTools: true },
        { id: "qwen-vl-max", supportsVision: true },
      ],
    },
    {
      id: "alibaba-coding-cn",
      name: "阿里云百炼 · Coding Plan",
      vendor: "Alibaba Cloud",
      region: "cn",
      baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "DASHSCOPE_CODING_API_KEY",
      icon: "bailian",
      websiteUrl: "https://bailian.console.aliyun.com",
      docsUrl: "https://qwenlm.github.io/qwen-code-docs/zh/users/configuration/auth/",
      defaultModel: "qwen3-coder-plus",
      models: [
        { id: "qwen3-coder-plus", supportsTools: true },
        { id: "qwen3-coder-next", supportsTools: true },
        { id: "qwen3.5-plus", supportsTools: true, supportsReasoning: true },
        { id: "qwen3-max", supportsTools: true, supportsReasoning: true },
        { id: "glm-4.7", supportsTools: true, supportsReasoning: true },
        { id: "kimi-k2.5", supportsTools: true },
      ],
      supportsModelListing: false,
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      vendor: "DeepSeek",
      region: "cn",
      baseUrl: "https://api.deepseek.com",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "DEEPSEEK_API_KEY",
      icon: "deepseek",
      websiteUrl: "https://platform.deepseek.com",
      docsUrl: "https://api-docs.deepseek.com/",
      defaultModel: "deepseek-v4-flash",
      models: [
        { id: "deepseek-v4-flash", supportsTools: true },
        { id: "deepseek-v4-pro", supportsTools: true, supportsReasoning: true },
      ],
    },
    {
      id: "zai",
      name: "智谱 GLM · API 按量付费",
      vendor: "Zhipu AI",
      region: "cn",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "GLM_API_KEY",
      icon: "zhipu",
      websiteUrl: "https://open.bigmodel.cn",
      docsUrl: "https://docs.bigmodel.cn/",
      defaultModel: "glm-5.1",
      models: [
        { id: "glm-5.2", supportsTools: true, supportsReasoning: true },
        { id: "glm-5.1", supportsTools: true, supportsReasoning: true },
        { id: "glm-4.6", supportsTools: true, supportsReasoning: true },
        { id: "glm-4.5", supportsTools: true },
        { id: "glm-4.5v", supportsVision: true },
      ],
    },
    {
      // 上游 v0.18.0 起 canonical `zai` 指 Global 端点（api.z.ai），本地
      // `zai` 预设保持中国端点（open.bigmodel.cn）——两者 base_url 均随预设
      // 显式落盘，不依赖后端默认，语义冲突不影响功能。此条目补齐 Global
      // 变体，供海外/出海用户选择（对应上游的 Z.AI endpoint picker）。
      id: "zai-global",
      name: "Z.AI GLM · 国际版",
      vendor: "Zhipu AI",
      region: "global",
      baseUrl: "https://api.z.ai/api/paas/v4",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "ZAI_API_KEY",
      icon: "zhipu",
      websiteUrl: "https://z.ai",
      docsUrl: "https://docs.z.ai/",
      defaultModel: "glm-5.1",
      models: [
        { id: "glm-5.2", supportsTools: true, supportsReasoning: true },
        { id: "glm-5.1", supportsTools: true, supportsReasoning: true },
        { id: "glm-4.6", supportsTools: true, supportsReasoning: true },
        { id: "glm-4.5", supportsTools: true },
        { id: "glm-4.5v", supportsVision: true },
      ],
    },
    {
      id: "zai-coding-cn",
      name: "智谱 GLM · Coding Plan",
      vendor: "Zhipu AI",
      region: "cn",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "GLM_CODING_API_KEY",
      icon: "zhipu",
      websiteUrl: "https://open.bigmodel.cn",
      docsUrl: "https://docs.bigmodel.cn/cn/api/introduction",
      defaultModel: "glm-5.1",
      models: [
        { id: "glm-5.2", supportsTools: true, supportsReasoning: true },
        { id: "glm-5.1", supportsTools: true, supportsReasoning: true },
        { id: "glm-4.7", supportsTools: true, supportsReasoning: true },
        { id: "glm-4.6", supportsTools: true, supportsReasoning: true },
      ],
      supportsModelListing: false,
    },
    {
      id: "kimi-for-coding",
      name: "Kimi / Moonshot",
      vendor: "Moonshot AI",
      region: "cn",
      baseUrl: "https://api.moonshot.cn/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "KIMI_API_KEY",
      icon: "kimi",
      websiteUrl: "https://www.kimi.com/code",
      docsUrl: "https://platform.moonshot.cn/docs",
      defaultModel: "kimi-k2.6",
      models: [
        { id: "kimi-k2.7-code", supportsTools: true, supportsReasoning: true },
        { id: "kimi-k2.6", supportsTools: true },
        { id: "kimi-k2-0905-preview", supportsTools: true },
        { id: "kimi-latest", supportsTools: true },
        { id: "moonshot-v1-128k" },
        { id: "moonshot-v1-32k" },
      ],
    },
    {
      id: "stepfun",
      name: "阶跃星辰 · API 按量付费",
      vendor: "StepFun",
      region: "cn",
      baseUrl: "https://api.stepfun.com/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "STEP_API_KEY",
      icon: "stepfun",
      websiteUrl: "https://platform.stepfun.com",
      docsUrl: "https://platform.stepfun.com/docs/zh/guides/developer/openai",
      defaultModel: "step-3.7-flash",
      models: [
        { id: "step-3.7-flash", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "step-3.5-flash", supportsTools: true, supportsReasoning: true },
      ],
    },
    {
      id: "stepfun-step-plan",
      name: "阶跃星辰 · Step Plan",
      vendor: "StepFun",
      region: "cn",
      baseUrl: "https://api.stepfun.ai/step_plan/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "STEP_PLAN_API_KEY",
      icon: "stepfun",
      websiteUrl: "https://platform.stepfun.com",
      docsUrl: "https://platform.stepfun.ai/docs/en/step-plan/quick-start",
      defaultModel: "step-3.7-flash",
      models: [
        { id: "step-3.7-flash", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "step-3.5-flash", supportsTools: true, supportsReasoning: true },
      ],
      supportsModelListing: false,
    },
    {
      id: "volcengine-ark",
      name: "火山方舟 · API 按量付费",
      vendor: "Volcengine",
      region: "cn",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "ARK_API_KEY",
      icon: "volcengine",
      websiteUrl: "https://console.volcengine.com/ark",
      docsUrl: "https://www.volcengine.com/docs/82379/1554709",
      defaultModel: "doubao-seed-2-0-lite-260428",
      models: [
        { id: "doubao-seed-2-0-lite-260428", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "doubao-seed-2-0-mini-260428", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "doubao-seed-2-0-pro-260215", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "doubao-seed-2-0-lite-260215", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "doubao-seed-1-8-251228", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "doubao-seed-1-6-251015", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "doubao-seed-1-6-flash-250828", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "doubao-1-5-pro-32k-250115", supportsTools: true },
        { id: "deepseek-v4-pro-260425", supportsTools: true, supportsReasoning: true },
        { id: "deepseek-v4-flash-260425", supportsTools: true, supportsReasoning: true },
        { id: "deepseek-v3-2-251201", supportsTools: true, supportsReasoning: true },
      ],
      supportsModelListing: false,
    },
    {
      id: "volcengine-ark-coding",
      name: "火山方舟 · Coding Plan",
      vendor: "Volcengine",
      region: "cn",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "ARK_CODING_API_KEY",
      icon: "volcengine",
      websiteUrl: "https://www.volcengine.com/activity/codingplan",
      docsUrl: "https://developer.volcengine.com/articles/7615528054736945158",
      defaultModel: "ark-code-latest",
      models: [
        { id: "ark-code-latest", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "doubao-seed-2.0-code", supportsTools: true },
        { id: "doubao-seed-2.0-pro", supportsTools: true },
        { id: "doubao-seed-2.0-lite", supportsTools: true },
        { id: "doubao-seed-code", supportsTools: true },
        { id: "minimax-m2.5", supportsTools: true },
        { id: "glm-4.7", supportsTools: true, supportsReasoning: true },
        { id: "deepseek-v3.2", supportsTools: true, supportsReasoning: true },
        { id: "kimi-k2.5", supportsTools: true },
      ],
      supportsModelListing: false,
    },
    {
      id: "minimax-cn",
      name: "MiniMax · Token Plan",
      vendor: "MiniMax",
      region: "cn",
      baseUrl: "https://api.minimaxi.com/anthropic",
      apiMode: "anthropic_messages",
      transport: "anthropic_messages",
      apiKeyLabel: "MINIMAX_CN_API_KEY",
      icon: "minimax",
      websiteUrl: "https://platform.minimaxi.com",
      docsUrl: "https://platform.minimaxi.com/document",
      defaultModel: "MiniMax-M3",
      models: [
        { id: "MiniMax-M3", contextWindow: 1_000_000, supportsTools: true, supportsReasoning: true },
        { id: "MiniMax-M2.7", contextWindow: 204_800, supportsTools: true, supportsReasoning: true },
        { id: "MiniMax-M2.7-highspeed", contextWindow: 204_800, supportsTools: true, supportsReasoning: true },
        { id: "MiniMax-M2.5", contextWindow: 204_800, supportsTools: true },
        { id: "MiniMax-M2.5-highspeed", contextWindow: 204_800, supportsTools: true },
        { id: "MiniMax-M2.1", contextWindow: 204_800, supportsTools: true },
        { id: "MiniMax-M2.1-highspeed", contextWindow: 204_800, supportsTools: true },
        { id: "MiniMax-M2", contextWindow: 204_800, supportsTools: true },
      ],
      supportsModelListing: false,
    },
    {
      id: "baidu-qianfan",
      name: "百度智能云千帆",
      vendor: "Baidu Cloud",
      region: "cn",
      baseUrl: "https://qianfan.baidubce.com/v2",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "QIANFAN_API_KEY",
      icon: "baidu",
      websiteUrl: "https://console.bce.baidu.com/qianfan",
      docsUrl: "https://cloud.baidu.com/doc/WENXINWORKSHOP/index.html",
      defaultModel: "ernie-4.5-turbo-128k",
      models: [
        { id: "ernie-4.5-turbo-128k", supportsTools: true },
        { id: "ernie-x1-turbo-32k", supportsReasoning: true },
        { id: "ernie-4.0-turbo-8k" },
      ],
    },
    {
      id: "tencent-hunyuan",
      name: "腾讯混元",
      vendor: "Tencent Cloud",
      region: "cn",
      baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "HUNYUAN_API_KEY",
      icon: "hunyuan",
      websiteUrl: "https://cloud.tencent.com/product/hunyuan",
      docsUrl: "https://cloud.tencent.com/document/product/1729",
      defaultModel: "hunyuan-turbos-latest",
      models: [
        { id: "hunyuan-turbos-latest", supportsTools: true },
        { id: "hunyuan-large", supportsTools: true },
        { id: "hunyuan-vision", supportsVision: true },
      ],
    },
    {
      id: "xiaomi",
      name: "小米 MiMo · API 按量付费",
      vendor: "Xiaomi",
      region: "cn",
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "XIAOMI_API_KEY",
      icon: "xiaomi-mimo",
      websiteUrl: "https://platform.xiaomimimo.com",
      apiKeyAliases: ["MIMO_API_KEY"],
      docsUrl: "https://platform.xiaomimimo.com/docs/en-US/api/chat/openai-api",
      defaultModel: "mimo-v2.5-pro",
      models: [
        { id: "mimo-v2.5-pro-ultraspeed", supportsTools: true, supportsReasoning: true },
        { id: "mimo-v2.5-pro", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "mimo-v2.5", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "mimo-v2-flash", supportsTools: true },
      ],
    },
    {
      id: "xiaomi-token-plan",
      name: "小米 MiMo · Token Plan",
      vendor: "Xiaomi",
      region: "cn",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "XIAOMI_TOKEN_PLAN_API_KEY",
      icon: "xiaomi-mimo",
      websiteUrl: "https://platform.xiaomimimo.com/#/token-plan",
      docsUrl: "https://platform.xiaomimimo.com/#/console/plan-manage",
      defaultModel: "mimo-v2.5-pro",
      models: [
        { id: "mimo-v2.5-pro", label: "MiMo v2.5 Pro", supportsTools: true, supportsVision: true, supportsReasoning: true },
        { id: "mimo-v2.5", label: "MiMo v2.5", supportsTools: true, supportsVision: true, supportsReasoning: true },
      ],
      supportsModelListing: false,
    },
    {
      id: "siliconflow",
      name: "硅基流动 SiliconFlow",
      vendor: "SiliconFlow",
      region: "cn",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "SILICONFLOW_API_KEY",
      icon: "siliconflow",
      websiteUrl: "https://cloud.siliconflow.cn",
      docsUrl: "https://docs.siliconflow.cn/",
      defaultModel: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      models: [
        { id: "Qwen/Qwen3-Coder-480B-A35B-Instruct", supportsTools: true },
        { id: "zai-org/GLM-5.2", supportsTools: true, supportsReasoning: true },
        { id: "deepseek-ai/DeepSeek-V4-Pro", supportsTools: true, supportsReasoning: true },
        { id: "deepseek-ai/DeepSeek-V3.2", supportsTools: true },
        { id: "deepseek-ai/DeepSeek-R1", supportsReasoning: true },
      ],
    },
    {
      id: "modelscope",
      name: "魔搭 ModelScope",
      vendor: "ModelScope",
      region: "cn",
      baseUrl: "https://api-inference.modelscope.cn/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "MODELSCOPE_API_KEY",
      icon: "modelscope",
      websiteUrl: "https://modelscope.cn",
      docsUrl: "https://modelscope.cn/docs/model-service/API-Inference/intro",
      defaultModel: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      models: [
        { id: "Qwen/Qwen3-Coder-480B-A35B-Instruct", supportsTools: true },
        { id: "Qwen/Qwen3-235B-A22B-Instruct-2507", supportsTools: true },
        { id: "deepseek-ai/DeepSeek-V3.2", supportsTools: true },
      ],
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      vendor: "OpenRouter",
      region: "global",
      baseUrl: "https://openrouter.ai/api/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "OPENROUTER_API_KEY",
      icon: "openrouter",
      websiteUrl: "https://openrouter.ai",
      docsUrl: "https://openrouter.ai/docs/api-reference/overview",
      defaultModel: "openrouter/auto",
      models: [
        { id: "openrouter/auto", supportsTools: true, supportsVision: true },
      ],
    },
    {
      id: "longcat",
      name: "Longcat",
      vendor: "美团 Longcat",
      region: "cn",
      baseUrl: "https://api.longcat.chat/openai/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "LONGCAT_API_KEY",
      icon: "longcat",
      websiteUrl: "https://longcat.chat/platform",
      defaultModel: "LongCat-2.0",
      models: [
        { id: "LongCat-2.0", label: "LongCat 2.0", supportsTools: true },
      ],
    },
    {
      id: "nvidia",
      name: "Nvidia NIM",
      vendor: "NVIDIA",
      region: "global",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "NVIDIA_API_KEY",
      icon: "nvidia",
      websiteUrl: "https://build.nvidia.com",
      defaultModel: "moonshotai/kimi-k2.5",
      models: [
        { id: "moonshotai/kimi-k2.5", label: "Moonshot Kimi K2.5", supportsTools: true },
      ],
    },
    {
      id: "opencode-go",
      name: "OpenCode Go",
      vendor: "OpenCode",
      region: "global",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "OPENCODE_GO_API_KEY",
      icon: "opencode-go",
      websiteUrl: "https://opencode.ai/go",
      defaultModel: "glm-5.2",
      models: [
        { id: "glm-5.2", label: "GLM 5.2", contextWindow: 204800, supportsTools: true },
        { id: "glm-5.1", label: "GLM 5.1", contextWindow: 204800, supportsTools: true },
        { id: "kimi-k2.7-code", label: "Kimi K2.7 Code", contextWindow: 262144, supportsTools: true },
        { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", supportsTools: true },
        { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", supportsTools: true },
        { id: "mimo-v2.5-pro", label: "MiMo V2.5 Pro", contextWindow: 1048576, supportsTools: true },
      ],
    },
    {
      // 中转站类合作伙伴。promotion.url 带我们的邀请码；文案/链接的日常
      // 更新走远端 catalog 下发覆盖，不必发版。
      id: "packycode",
      name: "PackyCode",
      vendor: "PackyCode",
      region: "cn",
      baseUrl: "https://www.packyapi.com",
      apiMode: "anthropic_messages",
      transport: "anthropic_messages",
      apiKeyLabel: "PACKYCODE_API_KEY",
      icon: "packycode",
      websiteUrl: "https://www.packyapi.com",
      promotion: {
        url: "https://www.packyapi.com/register?aff=3lj3",
        badge: "partner",
      },
      defaultModel: "claude-opus-4-8",
      models: [
        { id: "claude-opus-4-8", label: "Claude Opus 4.8", supportsTools: true, supportsVision: true },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5", supportsTools: true, supportsVision: true },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", supportsTools: true, supportsVision: true },
      ],
      supportsModelListing: false,
    },
    {
      id: "ccsub",
      name: "CCSub",
      vendor: "CCSub",
      region: "cn",
      baseUrl: "https://www.ccsub.net/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "CCSUB_API_KEY",
      icon: "ccsub",
      websiteUrl: "https://www.ccsub.net",
      promotion: {
        url: "https://www.ccsub.net/register?ref=2QRN9EJ8",
        badge: "partner",
      },
      defaultModel: "gpt-5.5",
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", contextWindow: 400000, supportsTools: true },
      ],
    },
    {
      id: "apikeyfun",
      name: "APIKEY.FUN",
      vendor: "APIKEY.FUN",
      region: "cn",
      baseUrl: "https://api.apikey.fun",
      apiMode: "anthropic_messages",
      transport: "anthropic_messages",
      apiKeyLabel: "APIKEYFUN_API_KEY",
      icon: "apikeyfun",
      websiteUrl: "https://apikey.fun",
      promotion: {
        url: "https://apikey.fun/register?aff=38U8BP5JSMDX",
        badge: "partner",
      },
      defaultModel: "claude-opus-4-8",
      models: [
        { id: "claude-opus-4-8", label: "Claude Opus 4.8", contextWindow: 1000000, supportsTools: true, supportsVision: true },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 1000000, supportsTools: true, supportsVision: true },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextWindow: 200000, supportsTools: true, supportsVision: true },
      ],
      supportsModelListing: false,
    },
    {
      // 官网/邀请链接用 aigocode.app（我们的推广链接所在域名），API 端点
      // 沿用 cc-switch 验证过的 api.aigocode.com。
      id: "aigocode",
      name: "AIGoCode",
      vendor: "AIGoCode",
      region: "cn",
      baseUrl: "https://api.aigocode.com",
      apiMode: "anthropic_messages",
      transport: "anthropic_messages",
      apiKeyLabel: "AIGOCODE_API_KEY",
      icon: "aigocode",
      websiteUrl: "https://aigocode.app",
      promotion: {
        url: "https://aigocode.app/invite/VJE7ZWQA",
        badge: "partner",
      },
      defaultModel: "claude-opus-4-8",
      models: [
        { id: "claude-opus-4-8", label: "Claude Opus 4.8", supportsTools: true, supportsVision: true },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5", supportsTools: true, supportsVision: true },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", supportsTools: true, supportsVision: true },
      ],
      supportsModelListing: false,
    },
    {
      id: "rightcode",
      name: "RightCode",
      vendor: "RightCode",
      region: "cn",
      baseUrl: "https://www.right.codes/claude",
      apiMode: "anthropic_messages",
      transport: "anthropic_messages",
      apiKeyLabel: "RIGHTCODE_API_KEY",
      icon: "rightcode",
      websiteUrl: "https://www.right.codes",
      promotion: {
        url: "https://www.right.codes/register?aff=d7899e4a",
        badge: "partner",
      },
      defaultModel: "claude-opus-4-8",
      models: [
        { id: "claude-opus-4-8", label: "Claude Opus 4.8", supportsTools: true, supportsVision: true },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5", supportsTools: true, supportsVision: true },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", supportsTools: true, supportsVision: true },
      ],
      supportsModelListing: false,
    },
    {
      id: "aicodemirror",
      name: "AICodeMirror",
      vendor: "AICodeMirror",
      region: "cn",
      baseUrl: "https://api.aicodemirror.com/api/claudecode",
      apiMode: "anthropic_messages",
      transport: "anthropic_messages",
      apiKeyLabel: "AICODEMIRROR_API_KEY",
      icon: "aicodemirror",
      websiteUrl: "https://www.aicodemirror.com",
      promotion: {
        url: "https://www.aicodemirror.com/register?invitecode=JPDYK7",
        badge: "partner",
      },
      defaultModel: "claude-opus-4-8",
      models: [
        { id: "claude-opus-4-8", label: "Claude Opus 4.8", supportsTools: true, supportsVision: true },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5", supportsTools: true, supportsVision: true },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", supportsTools: true, supportsVision: true },
      ],
      supportsModelListing: false,
    },
    {
      // 官网/邀请链接用 sssaicode.com（我们的推广链接所在域名），API 端点
      // 沿用 cc-switch 验证过的 node-hk.sssaicodeapi.com。
      id: "sssaicode",
      name: "SSSAiCode",
      vendor: "SSSAiCode",
      region: "cn",
      baseUrl: "https://node-hk.sssaicodeapi.com/api",
      apiMode: "anthropic_messages",
      transport: "anthropic_messages",
      apiKeyLabel: "SSSAICODE_API_KEY",
      icon: "sssaicode",
      websiteUrl: "https://sssaicode.com",
      promotion: {
        url: "https://sssaicode.com/register?ref=Y687IE",
        badge: "partner",
      },
      defaultModel: "claude-opus-4-8",
      models: [
        { id: "claude-opus-4-8", label: "Claude Opus 4.8", supportsTools: true, supportsVision: true },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5", supportsTools: true, supportsVision: true },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", supportsTools: true, supportsVision: true },
      ],
      supportsModelListing: false,
    },
    {
      id: "micu",
      name: "Micu",
      vendor: "Micu",
      region: "cn",
      baseUrl: "https://www.micuapi.ai",
      apiMode: "anthropic_messages",
      transport: "anthropic_messages",
      apiKeyLabel: "MICU_API_KEY",
      icon: "micu",
      websiteUrl: "https://www.micuapi.ai",
      promotion: {
        url: "https://www.micuapi.ai/register?aff=9v98",
        badge: "partner",
      },
      defaultModel: "claude-opus-4-8",
      models: [
        { id: "claude-opus-4-8", label: "Claude Opus 4.8", supportsTools: true, supportsVision: true },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5", supportsTools: true, supportsVision: true },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", supportsTools: true, supportsVision: true },
      ],
      supportsModelListing: false,
    },
    {
      id: "nekocode",
      name: "NekoCode",
      vendor: "NekoCode",
      region: "cn",
      baseUrl: "https://nekocode.ai/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "NEKOCODE_API_KEY",
      icon: "nekocode",
      websiteUrl: "https://nekocode.ai",
      promotion: {
        url: "https://nekocode.ai?aff=WX7PPCLT",
        badge: "partner",
      },
      defaultModel: "gpt-5.5",
      models: [
        { id: "gpt-5.5", label: "GPT-5.5", supportsTools: true },
      ],
    },
    {
      id: "cubence",
      name: "Cubence",
      vendor: "Cubence",
      region: "cn",
      baseUrl: "https://api.cubence.com",
      apiMode: "anthropic_messages",
      transport: "anthropic_messages",
      apiKeyLabel: "CUBENCE_API_KEY",
      icon: "cubence",
      websiteUrl: "https://cubence.com",
      promotion: {
        url: "https://cubence.com/signup?code=SCGAKBEG",
        badge: "partner",
      },
      defaultModel: "claude-opus-4-8",
      models: [
        { id: "claude-opus-4-8", label: "Claude Opus 4.8", supportsTools: true, supportsVision: true },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5", supportsTools: true, supportsVision: true },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", supportsTools: true, supportsVision: true },
      ],
      supportsModelListing: false,
    },
  ],
};

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function cleanModels(models: ProviderCatalogModel[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    models.map((model) => [
      model.id,
      {
        ...(model.contextWindow ? { context_length: model.contextWindow } : {}),
        ...(model.supportsVision != null ? { supports_vision: model.supportsVision } : {}),
        ...(model.supportsTools != null ? { supports_tools: model.supportsTools } : {}),
        ...(model.supportsReasoning != null ? { supports_reasoning: model.supportsReasoning } : {}),
      },
    ]),
  );
}

export function getProviderEntry(config: Record<string, any> | undefined, providerId: string): Record<string, any> {
  return asRecord(asRecord(config?.providers)[providerId]);
}

export function maskSecretPreview(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length < 12) return "***";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function envPreview(envVars: EnvVarPreviewMap | undefined, key: string | undefined): string | undefined {
  const envKey = key?.trim();
  if (!envKey) return undefined;
  const info = envVars?.[envKey];
  if (!info?.is_set) return undefined;
  const preview = info.redacted_value?.trim();
  return preview || undefined;
}

function isLocalProviderBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".local");
  } catch {
    return false;
  }
}

export function providerApiKeyLabels(provider: ProviderPreset): string[] {
  const labels = [provider.apiKeyLabel, ...(provider.apiKeyAliases ?? [])]
    .map((key) => key.trim())
    .filter(Boolean);
  return Array.from(new Set(labels));
}

export function getProviderCredentialPreview(
  config: Record<string, any> | undefined,
  envVars: EnvVarPreviewMap | undefined,
  provider: ProviderPreset,
): string | undefined {
  const entry = getProviderEntry(config, provider.id);
  for (const key of providerApiKeyLabels(provider)) {
    const previewFromProviderEnv = envPreview(envVars, key);
    if (previewFromProviderEnv) return previewFromProviderEnv;
  }

  const previewFromEntryEnv = envPreview(envVars, String(entry.key_env || ""));
  if (previewFromEntryEnv) return previewFromEntryEnv;

  const rawApiKey = typeof entry.api_key === "string" ? entry.api_key : "";
  return rawApiKey.trim() ? maskSecretPreview(rawApiKey) : undefined;
}

export function providerHasSavedCredentials(
  config: Record<string, any> | undefined,
  providerId: string,
  envVars?: EnvVarPreviewMap,
  provider?: ProviderPreset,
): boolean {
  const entry = getProviderEntry(config, providerId);
  if (provider && providerApiKeyLabels(provider).some((key) => envVars?.[key]?.is_set)) return true;
  const keyEnv = typeof entry.key_env === "string" ? entry.key_env : "";
  if (keyEnv && envVars?.[keyEnv]?.is_set) return true;
  const baseUrl = typeof entry.base_url === "string" ? entry.base_url : provider?.baseUrl ?? "";
  const model = typeof entry.model === "string" ? entry.model : provider?.defaultModel ?? "";
  if (provider?.isCustom && baseUrl && model && isLocalProviderBaseUrl(baseUrl)) return true;
  return Boolean(entry.api_key || entry.key_env);
}

export function buildProviderConfigUpdate(
  config: Record<string, any>,
  preset: ProviderPreset,
  input: ProviderConfigInput,
): Record<string, any> {
  const configWithProvider = buildProviderSettingsUpdate(config, preset, input);
  return buildCurrentModelConfigUpdate(configWithProvider, preset, input);
}

export function buildProviderSettingsUpdate(
  config: Record<string, any>,
  preset: ProviderPreset,
  input: ProviderConfigInput,
): Record<string, any> {
  const providers = asRecord(config.providers);
  const existingProvider = asRecord(providers[preset.id]);
  const existingModel = asRecord(config.model);
  const nextApiKey =
    input.apiKey.trim() ||
    String(existingProvider.api_key || existingModel.api_key || "");
  const baseUrl = input.baseUrl.trim() || preset.baseUrl;
  const model = input.model.trim() || preset.defaultModel;
  const providerEntry: Record<string, any> = {
    ...existingProvider,
    name: preset.name,
    base_url: baseUrl,
    api_mode: preset.apiMode,
    transport: preset.transport,
    model,
    models: cleanModels(preset.models),
  };

  if (nextApiKey) providerEntry.api_key = nextApiKey;
  else delete providerEntry.api_key;

  return {
    ...config,
    providers: {
      ...providers,
      [preset.id]: providerEntry,
    },
  };
}

export function buildCurrentModelConfigUpdate(
  config: Record<string, any>,
  preset: ProviderPreset,
  input: ProviderConfigInput,
): Record<string, any> {
  const providers = asRecord(config.providers);
  const existingProvider = asRecord(providers[preset.id]);
  const existingModel = asRecord(config.model);
  const nextApiKey =
    input.apiKey.trim() ||
    String(existingProvider.api_key || existingModel.api_key || "");
  const baseUrl = input.baseUrl.trim() || String(existingProvider.base_url || preset.baseUrl);
  const model = input.model.trim() || String(existingProvider.model || preset.defaultModel);

  return {
    ...config,
    model: {
      ...existingModel,
      provider: preset.id,
      default: model,
      base_url: baseUrl,
      api_mode: preset.apiMode,
      ...(nextApiKey ? { api_key: nextApiKey } : {}),
    },
    // 顶层字段，由后端 _denormalize_config_from_web() 落盘为 model.context_length。
    // 覆盖值绑定「当前模型」语义：切到新模型时用户没填即写回 0，自动重置旧覆盖，
    // 避免把上一个模型的窗口串到新模型。
    model_context_length: parseContextWindowInput(input.contextWindow),
  };
}

export function mergeProviderCatalog(base: ProviderCatalog, remote: ProviderCatalog): ProviderCatalog {
  const byId = new Map(base.providers.map((provider) => [provider.id, provider]));
  for (const provider of remote.providers) {
    const builtin = byId.get(provider.id);
    // Security guard: a compromised/hijacked catalog response must not be able
    // to redirect an already-configured provider's traffic (and its API key)
    // to a different endpoint. Remote entries may update copy, promotion,
    // models and links for built-in providers, but never their wire settings.
    // Brand-new providers keep their own settings — the user still has to
    // opt in by configuring a key for them.
    byId.set(provider.id, builtin
      ? {
        ...provider,
        baseUrl: builtin.baseUrl,
        apiMode: builtin.apiMode,
        transport: builtin.transport,
        apiKeyLabel: builtin.apiKeyLabel,
      }
      : provider);
  }
  return {
    version: remote.version || base.version,
    providers: Array.from(byId.values()),
  };
}

const PROMOTION_BADGES = new Set(["partner", "prime"]);

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeRemotePromotion(promotion: unknown): ProviderPromotion | undefined {
  if (!promotion || typeof promotion !== "object" || Array.isArray(promotion)) return undefined;
  const record = promotion as Record<string, unknown>;
  if (!isHttpsUrl(record.url)) return undefined;
  const badge = typeof record.badge === "string" && PROMOTION_BADGES.has(record.badge)
    ? record.badge as ProviderPromotion["badge"]
    : undefined;
  return {
    url: record.url,
    ...(badge ? { badge } : {}),
  };
}

function normalizeRemoteProvider(provider: Partial<ProviderPreset> | undefined): ProviderPreset | null {
  if (!provider?.id || !provider.name || !provider.baseUrl || !provider.defaultModel) {
    return null;
  }
  const apiMode: ProviderApiMode =
    provider.apiMode === "anthropic_messages" || provider.apiMode === "codex_responses"
      ? provider.apiMode
      : "chat_completions";
  const transport: ProviderTransport =
    provider.transport === "anthropic_messages" || provider.transport === "codex_responses"
      ? provider.transport
      : "openai_chat";
  const models = Array.isArray(provider.models) && provider.models.length > 0
    ? provider.models.filter((model): model is ProviderCatalogModel => Boolean(model?.id))
    : [{ id: provider.defaultModel }];
  const apiKeyAliases = Array.isArray(provider.apiKeyAliases)
    ? Array.from(new Set(
      provider.apiKeyAliases
        .filter((key): key is string => typeof key === "string")
        .map((key) => key.trim())
        .filter(Boolean),
    ))
    : [];

  const promotion = normalizeRemotePromotion(provider.promotion);

  return {
    id: provider.id,
    name: provider.name,
    vendor: provider.vendor || provider.name,
    region: provider.region === "global" ? "global" : "cn",
    baseUrl: provider.baseUrl,
    apiMode,
    transport,
    apiKeyLabel: provider.apiKeyLabel || "API Key",
    ...(apiKeyAliases.length > 0 ? { apiKeyAliases } : {}),
    docsUrl: provider.docsUrl,
    ...(isHttpsUrl(provider.websiteUrl) ? { websiteUrl: provider.websiteUrl } : {}),
    ...(typeof provider.icon === "string" && provider.icon.trim() ? { icon: provider.icon.trim() } : {}),
    ...(promotion ? { promotion } : {}),
    defaultModel: provider.defaultModel,
    models,
    supportsModelListing: typeof provider.supportsModelListing === "boolean" ? provider.supportsModelListing : undefined,
  };
}

export async function fetchRemoteProviderCatalog(url: string): Promise<ProviderCatalog> {
  const data = await fetchExternalJSON<Partial<ProviderCatalog>>(url, {
    headers: { Accept: "application/json" },
  });
  if (!data || !Array.isArray(data.providers)) {
    throw new Error("Provider catalog response is invalid.");
  }
  return {
    version: typeof data.version === "string" ? data.version : "remote",
    providers: data.providers
      .map((provider) => normalizeRemoteProvider(provider as Partial<ProviderPreset>))
      .filter((provider): provider is ProviderPreset => Boolean(provider)),
  };
}
