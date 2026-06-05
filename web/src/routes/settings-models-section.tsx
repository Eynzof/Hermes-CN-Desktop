import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useConfig, useModelInfo, useSaveConfig } from "@/hooks/use-config";
import { useDeleteEnv, useEnvVars, useRevealEnv, useSetEnv } from "@/hooks/use-env";
import { useGateway } from "@/hooks/use-gateway";
import { useProviderModels } from "@/hooks/use-provider-models";
import type { ModelInfo, ProviderProbeResult } from "@hermes/protocol";
import {
  BUILTIN_PROVIDER_CATALOG,
  buildProviderConfigUpdate,
  buildProviderSettingsUpdate,
  getProviderEntry,
  providerHasSavedCredentials,
  sortProvidersForCnEdition,
  TOP5_PROVIDER_IDS,
  type ProviderPreset,
} from "@/lib/provider-catalog";
import { useProviderCatalog } from "@/hooks/use-provider-catalog";
import { ModelCombobox } from "@/components/settings/model-combobox";
import { translateEnvCategory, translateEnvVar } from "@/lib/env-translations";
import { rememberLastUsedModel } from "@/lib/last-used-model";
import type { EnvVarInfo } from "@hermes/protocol";
import { OAuthProvidersSection } from "./settings-oauth-section";
import s from "./settings.module.css";

const PROVIDER_GROUPS: { prefix: string; name: string; priority: number }[] = [
  { prefix: "NOUS_", name: "Nous Portal", priority: 0 },
  { prefix: "ANTHROPIC_", name: "Anthropic", priority: 1 },
  { prefix: "DASHSCOPE_", name: "DashScope (Qwen)", priority: 2 },
  { prefix: "HERMES_QWEN_", name: "DashScope (Qwen)", priority: 2 },
  { prefix: "DEEPSEEK_", name: "DeepSeek", priority: 3 },
  { prefix: "GOOGLE_", name: "Gemini", priority: 4 },
  { prefix: "GEMINI_", name: "Gemini", priority: 4 },
  { prefix: "GLM_", name: "GLM / Z.AI", priority: 5 },
  { prefix: "ZAI_", name: "GLM / Z.AI", priority: 5 },
  { prefix: "Z_AI_", name: "GLM / Z.AI", priority: 5 },
  { prefix: "STEP_", name: "StepFun", priority: 6 },
  { prefix: "HF_", name: "Hugging Face", priority: 6 },
  { prefix: "KIMI_", name: "Kimi / Moonshot", priority: 7 },
  { prefix: "ARK_", name: "Volcengine", priority: 8 },
  { prefix: "MINIMAX_CN_", name: "MiniMax (China)", priority: 9 },
  { prefix: "MINIMAX_", name: "MiniMax", priority: 8 },
  { prefix: "OPENCODE_GO_", name: "OpenCode Go", priority: 10 },
  { prefix: "OPENCODE_ZEN_", name: "OpenCode Zen", priority: 11 },
  { prefix: "OPENROUTER_", name: "OpenRouter", priority: 12 },
  { prefix: "XIAOMI_", name: "Xiaomi MiMo", priority: 13 },
  { prefix: "MIMO_", name: "Xiaomi MiMo", priority: 13 },
  { prefix: "COMPSHARE_", name: "优云智算 (Compshare)", priority: 14 },
];

const PROVIDER_ACTION_LOADING_MIN_MS = 450;
const PROVIDER_SWITCH_LOADING_MIN_MS = 280;

type ModelSettingsTab = "main" | "auxiliary";
type CustomProviderMode = "custom" | "local";

type AuxiliaryTaskId =
  | "vision"
  | "compression"
  | "web_extract"
  | "title_generation"
  | "approval"
  | "mcp"
  | "skills_hub"
  | "triage_specifier"
  | "kanban_decomposer"
  | "profile_describer"
  | "curator";

interface AuxiliaryTaskDefinition {
  id: AuxiliaryTaskId;
  name: string;
  shortName: string;
  description: string;
  defaultTimeout: number;
  group: "common" | "advanced";
}

interface AuxiliaryTaskForm {
  provider: string;
  model: string;
  timeout: string;
  baseUrl: string;
  apiKey: string;
  downloadTimeout: string;
  extraBody: string;
}

interface LocalProviderPreset {
  name: string;
  baseUrl: string;
  model: string;
  tutorial: string;
}

const AUXILIARY_TASKS: AuxiliaryTaskDefinition[] = [
  {
    id: "vision",
    name: "视觉分析",
    shortName: "视觉",
    description: "图片附件、浏览器截图和 vision_analyze 会走这个槽位；主模型不支持图片时尤其重要。",
    defaultTimeout: 120,
    group: "common",
  },
  {
    id: "compression",
    name: "上下文压缩",
    shortName: "压缩",
    description: "长会话压缩和上下文总结会走这个槽位，建议使用便宜且长上下文的模型。",
    defaultTimeout: 120,
    group: "common",
  },
  {
    id: "web_extract",
    name: "网页抽取",
    shortName: "抽取",
    description: "网页、PDF 等内容抽取后的总结和合成会走这个槽位，默认超时更长。",
    defaultTimeout: 360,
    group: "common",
  },
  {
    id: "title_generation",
    name: "标题生成",
    shortName: "标题",
    description: "新会话标题自动生成会走这个槽位，适合很快、很便宜的小模型。",
    defaultTimeout: 30,
    group: "common",
  },
  {
    id: "approval",
    name: "智能审批",
    shortName: "审批",
    description: "smart approval 判断低风险命令时会走这个槽位，要求稳定但不需要大模型。",
    defaultTimeout: 30,
    group: "common",
  },
  {
    id: "mcp",
    name: "MCP 路由",
    shortName: "MCP",
    description: "MCP 工具选择和路由判断会走这个槽位，适合响应快的模型。",
    defaultTimeout: 30,
    group: "common",
  },
  {
    id: "skills_hub",
    name: "技能中心",
    shortName: "技能",
    description: "Skill Hub 相关辅助调用使用这个槽位。",
    defaultTimeout: 30,
    group: "advanced",
  },
  {
    id: "triage_specifier",
    name: "Kanban 需求扩写",
    shortName: "扩写",
    description: "把 Kanban triage 中的一句话扩写为可执行规格。",
    defaultTimeout: 120,
    group: "advanced",
  },
  {
    id: "kanban_decomposer",
    name: "Kanban 任务分解",
    shortName: "分解",
    description: "把 Kanban 任务拆成任务图并路由到对应档案。",
    defaultTimeout: 180,
    group: "advanced",
  },
  {
    id: "profile_describer",
    name: "档案描述生成",
    shortName: "档案",
    description: "自动生成档案的能力描述，属于短文本辅助调用。",
    defaultTimeout: 60,
    group: "advanced",
  },
  {
    id: "curator",
    name: "Skill 审查",
    shortName: "审查",
    description: "Skill 使用审查 fork 会走这个槽位，可能持续数分钟。",
    defaultTimeout: 600,
    group: "advanced",
  },
];

const LOCAL_PROVIDER_PRESETS: LocalProviderPreset[] = [
  {
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "local-model",
    tutorial: "打开 Developer / Local Server，加载模型后点击 Start Server；模型名以 /v1/models 返回为准。",
  },
  {
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5-coder:7b",
    tutorial: "先运行 ollama pull qwen2.5-coder:7b，并确认 ollama serve 正在运行；API Key 通常留空。",
  },
  {
    name: "vLLM",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "Qwen/Qwen2.5-Coder-7B-Instruct",
    tutorial: "启动 OpenAI-compatible server，建议用 --served-model-name 固定一个容易填写的模型名。",
  },
  {
    name: "llama.cpp",
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "local-model",
    tutorial: "启动 llama-server 的 OpenAI 兼容接口；未启用鉴权时 API Key 留空即可。",
  },
];

const AUXILIARY_TASK_BY_ID = Object.fromEntries(
  AUXILIARY_TASKS.map((task) => [task.id, task]),
) as Record<AuxiliaryTaskId, AuxiliaryTaskDefinition>;

const AUXILIARY_PROVIDER_PRESETS: { id: string; name: string; hint: string; models: string[] }[] = [
  {
    id: "auto",
    name: "Auto 自动选择",
    hint: "优先复用主模型，必要时 fallback 到可用 provider。",
    models: [],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    hint: "适合 vision、compression、approval 等辅助任务。",
    models: [
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-5-20250929",
      "claude-3-5-haiku-latest",
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    hint: "可路由 Gemini、Claude 等视觉或便宜快速模型。",
    models: [
      "google/gemini-3-flash-preview",
      "google/gemini-2.5-flash",
      "anthropic/claude-haiku-4.5",
      "openrouter/auto",
    ],
  },
  {
    id: "nous",
    name: "Nous Portal",
    hint: "使用 Nous 登录状态或账号额度。",
    models: [
      "google/gemini-3-flash-preview",
      "google/gemini-2.5-flash",
      "anthropic/claude-haiku-4.5",
    ],
  },
];

const TEXT_ONLY_VISION_PROVIDERS = new Set([
  "deepseek",
  "minimax",
  "minimax-cn",
  "minimax-oauth",
  "kimi-for-coding",
  "kimi-coding",
  "kimi-coding-cn",
]);

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function getAuxiliarySlot(config: Record<string, any> | undefined, task: AuxiliaryTaskId): Record<string, any> {
  const auxiliary = asRecord(config?.auxiliary);
  return asRecord(auxiliary[task]);
}

function auxiliaryFormFromConfig(
  config: Record<string, any> | undefined,
  task: AuxiliaryTaskId,
): AuxiliaryTaskForm {
  const slot = getAuxiliarySlot(config, task);
  const def = AUXILIARY_TASK_BY_ID[task];
  const extraBody = asRecord(slot.extra_body);
  return {
    provider: String(slot.provider || "auto"),
    model: String(slot.model || ""),
    timeout: String(slot.timeout ?? def.defaultTimeout),
    baseUrl: String(slot.base_url || ""),
    apiKey: "",
    downloadTimeout: String(slot.download_timeout ?? 30),
    extraBody: Object.keys(extraBody).length > 0
      ? JSON.stringify(extraBody, null, 2)
      : "",
  };
}

function getImageInputMode(config: Record<string, any> | undefined): "auto" | "native" | "text" {
  const mode = String(asRecord(config?.agent).image_input_mode || "auto");
  return mode === "native" || mode === "text" ? mode : "auto";
}

function parsePositiveNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseExtraBody(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("extra_body 必须是 JSON object");
  }
  return parsed as Record<string, unknown>;
}

function buildAuxiliaryTaskUpdate(
  config: Record<string, any>,
  task: AuxiliaryTaskId,
  form: AuxiliaryTaskForm,
): Record<string, any> {
  const def = AUXILIARY_TASK_BY_ID[task];
  const auxiliary = asRecord(config.auxiliary);
  const current = getAuxiliarySlot(config, task);
  const provider = form.provider.trim() || "auto";
  const nextSlot: Record<string, any> = {
    ...current,
    provider,
    model: provider === "auto" ? "" : form.model.trim(),
    timeout: parsePositiveNumber(form.timeout, def.defaultTimeout),
    base_url: form.baseUrl.trim(),
    extra_body: parseExtraBody(form.extraBody),
  };

  if (task === "vision") {
    nextSlot.download_timeout = parsePositiveNumber(form.downloadTimeout, 30);
  } else {
    delete nextSlot.download_timeout;
  }

  if (provider === "auto") {
    nextSlot.base_url = "";
    nextSlot.model = "";
    delete nextSlot.api_key;
  } else if (form.apiKey.trim()) {
    nextSlot.api_key = form.apiKey.trim();
  }

  return {
    ...config,
    auxiliary: {
      ...auxiliary,
      [task]: nextSlot,
    },
  };
}

function buildAuxiliaryTaskReset(config: Record<string, any>, task: AuxiliaryTaskId): Record<string, any> {
  const auxiliary = asRecord(config.auxiliary);
  const current = getAuxiliarySlot(config, task);
  return {
    ...config,
    auxiliary: {
      ...auxiliary,
      [task]: {
        ...current,
        provider: "auto",
        model: "",
        base_url: "",
        extra_body: {},
        timeout: AUXILIARY_TASK_BY_ID[task].defaultTimeout,
        ...(task === "vision" ? { download_timeout: 30 } : {}),
      },
    },
  };
}

function buildAllAuxiliaryReset(config: Record<string, any>): Record<string, any> {
  return AUXILIARY_TASKS.reduce(
    (next, task) => buildAuxiliaryTaskReset(next, task.id),
    config,
  );
}

function buildImageInputModeUpdate(
  config: Record<string, any>,
  mode: "auto" | "native" | "text",
): Record<string, any> {
  const agent = asRecord(config.agent);
  return {
    ...config,
    agent: {
      ...agent,
      image_input_mode: mode,
    },
  };
}

function describeAuxiliarySlot(config: Record<string, any> | undefined, task: AuxiliaryTaskId): string {
  const slot = getAuxiliarySlot(config, task);
  const provider = String(slot.provider || "auto");
  const model = String(slot.model || "");
  if (provider === "auto") return "Auto";
  return model ? `${provider} · ${model}` : provider;
}

function getProviderDisplayName(providerId: string, providers: ProviderPreset[]): string {
  if (providerId === "auto") return "Auto 自动选择";
  const preset = AUXILIARY_PROVIDER_PRESETS.find((p) => p.id === providerId);
  if (preset) return preset.name;
  const provider = providers.find((p) => p.id === providerId);
  return provider ? provider.name : providerId;
}

function getAuxiliaryModelOptions(providerId: string, providers: ProviderPreset[], currentModel: string): string[] {
  const options = new Set<string>();
  const auxPreset = AUXILIARY_PROVIDER_PRESETS.find((provider) => provider.id === providerId);
  for (const model of auxPreset?.models ?? []) options.add(model);
  const provider = providers.find((item) => item.id === providerId);
  for (const model of provider?.models ?? []) options.add(model.id);
  if (provider?.defaultModel) options.add(provider.defaultModel);
  if (currentModel) options.add(currentModel);
  return Array.from(options);
}

function isLikelyVisionCapable(providerId: string, model: string, providers: ProviderPreset[]): boolean {
  if (!providerId || providerId === "auto") return true;
  if (TEXT_ONLY_VISION_PROVIDERS.has(providerId)) return false;
  if (providerId === "anthropic" || providerId === "openrouter" || providerId === "nous") return true;
  const provider = providers.find((item) => item.id === providerId);
  const modelEntry = provider?.models.find((item) => item.id === model);
  if (modelEntry?.supportsVision) return true;
  const normalized = `${providerId} ${model}`.toLowerCase();
  return /\b(vl|vision|gemini|claude|gpt-4o|pixtral|llava|qwen-vl)\b/.test(normalized);
}

function getProviderGroup(key: string): string {
  for (const g of PROVIDER_GROUPS) {
    if (key.startsWith(g.prefix)) return g.name;
  }
  return "其他";
}

function getProviderPriority(name: string): number {
  return PROVIDER_GROUPS.find((g) => g.name === name)?.priority ?? 99;
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

export function ModelsSection() {
  const { data: envVars, isLoading } = useEnvVars();
  const { data: config, isLoading: configLoading } = useConfig();
  const { data: modelInfo } = useModelInfo();
  const saveConfig = useSaveConfig();
  const setEnv = useSetEnv();
  const deleteEnv = useDeleteEnv();
  const revealEnv = useRevealEnv();
  const { probeProvider, setRuntimeModel } = useGateway();
  const { catalog, message: catalogMessage, refresh: refreshCatalog } = useProviderCatalog();
  const [activeModelTab, setActiveModelTab] = useState<ModelSettingsTab>("main");
  const [probeState, setProbeState] = useState<{
    providerId: string;
    status: "pending" | "ok" | "error";
    result?: ProviderProbeResult;
    message?: string;
  } | null>(null);
  const initialProvider =
    BUILTIN_PROVIDER_CATALOG.providers.find((p) => p.id === TOP5_PROVIDER_IDS[0]) ??
    BUILTIN_PROVIDER_CATALOG.providers[0];
  const [selectedProviderId, setSelectedProviderId] = useState(initialProvider?.id ?? "");
  const [providerPanelLoading, setProviderPanelLoading] = useState(false);
  const selectedProviderIdRef = useRef(selectedProviderId);
  const [providerForm, setProviderForm] = useState({
    apiKey: "",
    baseUrl: initialProvider?.baseUrl ?? "",
    model: initialProvider?.defaultModel ?? "",
  });
  // Last saved values for the selected provider. Used to compute whether the
  // form is dirty (vs. baseline) so the save button can show an idle "已保存"
  // state until the user actually changes something.
  const [savedSnapshot, setSavedSnapshot] = useState<{
    baseUrl: string;
    model: string;
    providerId: string;
  } | null>(null);
  const [savedFlashFor, setSavedFlashFor] = useState<string | null>(null);
  const [providerSavePending, setProviderSavePending] = useState(false);
  const [providerSetCurrentPending, setProviderSetCurrentPending] = useState(false);
  const [providerSaveError, setProviderSaveError] = useState("");
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [showEnvAdvanced, setShowEnvAdvanced] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customProviderMode, setCustomProviderMode] = useState<CustomProviderMode>("custom");
  const [customForm, setCustomForm] = useState({
    name: "",
    baseUrl: "",
    apiKey: "",
    model: "",
  });
  const [selectedAuxTask, setSelectedAuxTask] = useState<AuxiliaryTaskId>("vision");
  const [auxForm, setAuxForm] = useState<AuxiliaryTaskForm>(() =>
    auxiliaryFormFromConfig(config, "vision"));
  const [auxAdvancedOpen, setAuxAdvancedOpen] = useState(false);
  const [auxSavingTask, setAuxSavingTask] = useState<AuxiliaryTaskId | "__all__" | "image_mode" | null>(null);
  const [auxSavedTask, setAuxSavedTask] = useState<AuxiliaryTaskId | "__all__" | "image_mode" | null>(null);
  const [auxError, setAuxError] = useState("");
  const customDialogTitleId = useId();
  const selectProvider = useCallback((providerId: string) => {
    if (!providerId || selectedProviderIdRef.current === providerId) return;
    selectedProviderIdRef.current = providerId;
    setProviderPanelLoading(true);
    setSelectedProviderId(providerId);
  }, []);

  useEffect(() => {
    selectedProviderIdRef.current = selectedProviderId;
  }, [selectedProviderId]);

  useEffect(() => {
    if (!providerPanelLoading) return;
    const handle = window.setTimeout(
      () => setProviderPanelLoading(false),
      PROVIDER_SWITCH_LOADING_MIN_MS,
    );
    return () => window.clearTimeout(handle);
  }, [providerPanelLoading, selectedProviderId]);

  const closeCustomForm = useCallback(() => {
    setShowCustomForm(false);
    setCustomProviderMode("custom");
    setCustomForm({ name: "", baseUrl: "", apiKey: "", model: "" });
  }, []);

  const openCustomProviderForm = useCallback((mode: CustomProviderMode) => {
    setCustomProviderMode(mode);
    setCustomForm({ name: "", baseUrl: "", apiKey: "", model: "" });
    setShowCustomForm(true);
  }, []);

  const applyLocalProviderPreset = useCallback((preset: LocalProviderPreset) => {
    setCustomForm((prev) => ({
      ...prev,
      name: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.model,
    }));
  }, []);
  useEffect(() => {
    if (!showCustomForm) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCustomForm();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showCustomForm, closeCustomForm]);

  const customProviders = useMemo<ProviderPreset[]>(() => {
    const providers = config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, any>).providers
      : null;
    if (!providers || typeof providers !== "object") return [];
    const knownIds = new Set(catalog.providers.map((p) => p.id));
    const customs: ProviderPreset[] = [];
    for (const [id, raw] of Object.entries(providers)) {
      if (knownIds.has(id) || !id.startsWith("custom:")) continue;
      const v = raw && typeof raw === "object" ? raw as Record<string, any> : {};
      const model = typeof v.model === "string" ? v.model : "";
      customs.push({
        id,
        name: typeof v.name === "string" && v.name ? v.name : id.replace(/^custom:/, ""),
        vendor: isLocalProviderBaseUrl(typeof v.base_url === "string" ? v.base_url : "") ? "本地部署" : "自定义",
        region: "cn",
        baseUrl: typeof v.base_url === "string" ? v.base_url : "",
        apiMode: v.api_mode === "anthropic_messages" || v.api_mode === "codex_responses"
          ? v.api_mode : "chat_completions",
        transport: v.transport === "anthropic_messages" || v.transport === "codex_responses"
          ? v.transport : "openai_chat",
        apiKeyLabel: "API Key",
        defaultModel: model,
        models: model ? [{ id: model, supportsTools: true }] : [],
        isCustom: true,
      });
    }
    return customs;
  }, [config, catalog.providers]);

  const allProviders = useMemo(
    () => [...catalog.providers, ...customProviders],
    [catalog.providers, customProviders],
  );
  const auxiliaryProviderOptions = useMemo(() => {
    const options = new Map<string, { id: string; name: string; hint: string }>();
    for (const provider of AUXILIARY_PROVIDER_PRESETS) {
      options.set(provider.id, { id: provider.id, name: provider.name, hint: provider.hint });
    }
    for (const provider of allProviders) {
      options.set(provider.id, {
        id: provider.id,
        name: provider.name,
        hint: provider.vendor,
      });
    }
    const currentProvider = auxForm.provider.trim();
    if (currentProvider && !options.has(currentProvider)) {
      options.set(currentProvider, {
        id: currentProvider,
        name: currentProvider,
        hint: "当前配置中的 provider",
      });
    }
    return Array.from(options.values());
  }, [allProviders, auxForm.provider]);
  const selectedProvider = useMemo<ProviderPreset | undefined>(
    () => allProviders.find((provider) => provider.id === selectedProviderId) ?? allProviders[0],
    [allProviders, selectedProviderId],
  );
  const orderedProviders = useMemo(
    () => sortProvidersForCnEdition(allProviders),
    [allProviders],
  );
  const filteredProviders = useMemo(() => {
    const query = providerSearch.trim().toLowerCase();
    if (!query) return orderedProviders;
    return orderedProviders.filter((provider) => {
      const searchable = [
        provider.name,
        provider.vendor,
        provider.id,
        provider.defaultModel,
        ...provider.models.map((model) => model.label ?? model.id),
      ].join(" ").toLowerCase();
      return searchable.includes(query);
    });
  }, [orderedProviders, providerSearch]);
  const selectedProviderEntry = selectedProvider
    ? getProviderEntry(config, selectedProvider.id)
    : {};
  const selectedHasCredentials = selectedProvider
    ? providerHasSavedCredentials(config, selectedProvider.id)
    : false;
  const selectedProviderCanOmitApiKey = selectedProvider
    ? isLocalProviderBaseUrl(providerForm.baseUrl || selectedProvider.baseUrl)
    : false;
  const currentProviderId = modelInfo?.provider ||
    (config?.model && typeof config.model === "object" && !Array.isArray(config.model)
      ? String((config.model as Record<string, unknown>).provider ?? "")
      : "");
  const configuredAuxiliaryCount = useMemo(
    () => AUXILIARY_TASKS.filter((task) => {
      const slot = getAuxiliarySlot(config, task.id);
      return String(slot.provider || "auto") !== "auto" || Boolean(String(slot.model || ""));
    }).length,
    [config],
  );
  const configuredCount = useMemo(
    () => allProviders.filter((provider) => providerHasSavedCredentials(config, provider.id)).length,
    [allProviders, config],
  );
  const providerEnvEntries = useMemo(
    () => Object.entries(envVars ?? {})
      .filter(([, v]) => v.category === "provider")
      .sort(([aKey], [bKey]) => getProviderPriority(getProviderGroup(aKey)) - getProviderPriority(getProviderGroup(bKey))),
    [envVars],
  );
  const nonProviderGroups = useMemo(() => {
    if (!envVars) return [];
    return ["tool", "messaging", "setting", "service"]
      .map((cat) => ({
        category: cat,
        label: translateEnvCategory(cat),
        entries: Object.entries(envVars).filter(([, v]) => v.category === cat && !v.advanced),
      }))
      .filter((g) => g.entries.length > 0);
  }, [envVars]);

  const liveApiKey = providerForm.apiKey.trim() ||
    (typeof selectedProviderEntry.api_key === "string" ? selectedProviderEntry.api_key : "");
  const supportsModelListing = selectedProvider?.supportsModelListing !== false;
  const modelsQuery = useProviderModels(providerForm.baseUrl, liveApiKey || undefined);
  const liveModelIds = supportsModelListing ? modelsQuery.data?.models ?? [] : [];
  const mergedModelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const id of liveModelIds) set.add(id);
    if (selectedProvider) for (const m of selectedProvider.models) set.add(m.id);
    if (providerForm.model) set.add(providerForm.model);
    return Array.from(set);
  }, [liveModelIds, selectedProvider, providerForm.model]);

  const refreshLabel = modelsQuery.isFetching
    ? "刷新中…"
    : modelsQuery.isError
      ? "刷新失败 重试"
      : modelsQuery.data
        ? `已加载 ${modelsQuery.data.models.length} 个`
        : "刷新模型列表";

  const refreshErrorText = useMemo(() => {
    if (!supportsModelListing || !modelsQuery.isError) return "";
    const msg = modelsQuery.error instanceof Error ? modelsQuery.error.message : String(modelsQuery.error);
    if (/\b404\b|not found/i.test(msg)) return "此服务商未提供 /models 端点";
    if (/\b401\b|\b403\b|unauthor/i.test(msg)) return "API Key 无效或未保存";
    if (/Failed to fetch|NetworkError|TypeError|cors/i.test(msg)) {
      return "无法连接，可能被浏览器跨域策略拦截；桌面端可正常使用";
    }
    return msg;
  }, [supportsModelListing, modelsQuery.isError, modelsQuery.error]);

  useEffect(() => {
    if (!selectedProvider) return;
    const model = typeof selectedProviderEntry.model === "string"
      ? selectedProviderEntry.model
      : selectedProvider.defaultModel;
    const baseUrl = typeof selectedProviderEntry.base_url === "string"
      ? selectedProviderEntry.base_url
      : selectedProvider.baseUrl;
    setProviderForm({ apiKey: "", baseUrl, model });
    setSavedSnapshot({ baseUrl, model, providerId: selectedProvider.id });
  }, [
    selectedProvider,
    selectedProviderEntry.base_url,
    selectedProviderEntry.model,
  ]);

  useEffect(() => {
    setAuxForm(auxiliaryFormFromConfig(config, selectedAuxTask));
    setAuxAdvancedOpen(false);
    setAuxError("");
  }, [config, selectedAuxTask]);

  // Switching to a different provider hides any stale "已保存" indicator.
  useEffect(() => {
    setSavedFlashFor(null);
    setProbeState(null);
    setProviderSaveError("");
  }, [selectedProvider?.id]);

  const handleProbe = useCallback(async () => {
    if (!selectedProvider) return;
    const apiKey = providerForm.apiKey.trim() ||
      (typeof selectedProviderEntry.api_key === "string" ? selectedProviderEntry.api_key : "");
    const baseUrl = providerForm.baseUrl.trim() || selectedProvider.baseUrl;
    setProbeState({ providerId: selectedProvider.id, status: "pending" });
    try {
      // Map catalog id → backend canonical slug for env-var fallback. When
      // the catalog id has no canonical equivalent (e.g. baidu-qianfan,
      // tencent-hunyuan — not in CANONICAL_PROVIDERS), we pass the catalog
      // id; the backend handler tolerates unknown slugs as long as api_key
      // + base_url are supplied explicitly.
      const result = await probeProvider({
        provider: selectedProvider.id,
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
        timeout_ms: 8000,
      });
      setProbeState({
        providerId: selectedProvider.id,
        status: result.ok ? "ok" : "error",
        result,
      });
    } catch (error) {
      setProbeState({
        providerId: selectedProvider.id,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [probeProvider, providerForm.apiKey, providerForm.baseUrl, selectedProvider, selectedProviderEntry.api_key]);

  const probeForSelected = probeState && selectedProvider && probeState.providerId === selectedProvider.id
    ? probeState
    : null;

  const isFormDirty = !!(
    selectedProvider &&
    (providerForm.apiKey.trim() !== "" ||
      providerForm.baseUrl !== (savedSnapshot?.baseUrl ?? "") ||
      providerForm.model !== (savedSnapshot?.model ?? ""))
  );
  const showSavedFlash = !isFormDirty && savedFlashFor === selectedProvider?.id;
  const selectedProviderModel = selectedProvider
    ? (providerForm.model.trim() || selectedProvider.defaultModel)
    : "";
  const selectedProviderIsCurrent = Boolean(
    selectedProvider &&
    selectedProviderModel &&
    currentProviderId === selectedProvider.id &&
    modelInfo?.model === selectedProviderModel,
  );

  // Deep-link from the picker's "去设置" CTA: /models#provider-<slug> selects
  // and scrolls to that provider so the user lands on the right key field.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    const match = hash.match(/^#provider-(.+)$/);
    if (!match) return;
    const targetId = decodeURIComponent(match[1]);
    if (!allProviders.some((p) => p.id === targetId)) return;
    selectProvider(targetId);
    // Wait one frame for the list item to mount with the new active state,
    // then scroll it into view with a soft highlight pulse.
    const handle = window.requestAnimationFrame(() => {
      const el = document.getElementById(`provider-${targetId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(handle);
    // intentionally only on mount + when catalog finishes loading
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProviders.length]);

  const handleReveal = async (key: string) => {
    if (revealedValues[key]) {
      setRevealedValues((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    const result = await revealEnv.mutateAsync(key);
    setRevealedValues((prev) => ({ ...prev, [key]: result.value }));
  };

  const handleSave = (key: string) => {
    setEnv.mutate({ key, value: editVal });
    setEditKey(null);
    setEditVal("");
  };

  const handleCatalogRefresh = () => {
    void refreshCatalog();
  };

  const handleProviderSave = async () => {
    if (!config || !selectedProvider) return;
    const pendingStartedAt = performance.now();
    const newApiKey = providerForm.apiKey.trim();
    const isCustomProvider = selectedProvider.id.startsWith("custom:");
    // Built-in providers (alibaba, deepseek, zai, kimi, ...): hermes-agent
    // only reads their API key from environment variables / ~/.hermes/.env,
    // never from config.yaml's providers.<id>.api_key. Mirror the key into
    // the named env var so chat requests actually find credentials. Custom
    // providers are read inline from config.yaml, so they don't need this.
    const savedBaseUrl = providerForm.baseUrl.trim() || selectedProvider.baseUrl;
    const savedModel = providerForm.model.trim() || selectedProvider.defaultModel;
    const providerId = selectedProvider.id;
    setProviderSavePending(true);
    setProviderSaveError("");
    try {
      if (newApiKey && !isCustomProvider && selectedProvider.apiKeyLabel) {
        await setEnv.mutateAsync({ key: selectedProvider.apiKeyLabel, value: newApiKey });
      }
      await saveConfig.mutateAsync(
        buildProviderSettingsUpdate(config, selectedProvider, providerForm),
      );
      setProviderForm((prev) => ({ ...prev, apiKey: "" }));
      setSavedSnapshot({
        baseUrl: savedBaseUrl,
        model: savedModel,
        providerId,
      });
      setSavedFlashFor(providerId);
    } catch (error) {
      setProviderSaveError(error instanceof Error ? error.message : String(error || "保存失败"));
    } finally {
      const elapsed = performance.now() - pendingStartedAt;
      if (elapsed < PROVIDER_ACTION_LOADING_MIN_MS) {
        await wait(PROVIDER_ACTION_LOADING_MIN_MS - elapsed);
      }
      setProviderSavePending(false);
    }
  };

  const handleSetCurrentModel = async () => {
    if (!config || !selectedProvider) return;
    const pendingStartedAt = performance.now();
    const newApiKey = providerForm.apiKey.trim();
    const savedBaseUrl = providerForm.baseUrl.trim() || selectedProvider.baseUrl;
    const savedModel = providerForm.model.trim() || selectedProvider.defaultModel;
    const providerId = selectedProvider.id;
    const providerName = selectedProvider.name;
    const isCustomProvider = providerId.startsWith("custom:");
    setProviderSetCurrentPending(true);
    setProviderSaveError("");
    try {
      if (newApiKey && !isCustomProvider && selectedProvider.apiKeyLabel) {
        await setEnv.mutateAsync({ key: selectedProvider.apiKeyLabel, value: newApiKey });
      }
      // Persist both providers.<id> and model.* before asking the live gateway
      // to hot-switch. First-run setups otherwise have no current provider for
      // gateway _apply_model_switch() to resolve, so it can fail before it ever
      // considers the explicit `--provider <id>` argument.
      await saveConfig.mutateAsync(
        buildProviderConfigUpdate(config, selectedProvider, providerForm),
      );
      // Same hot-switch path as the composer model picker: update the live
      // gateway runtime explicitly after disk config is already usable.
      await setRuntimeModel(savedModel, providerId);
      setProviderForm((prev) => ({ ...prev, apiKey: "" }));
      setSavedSnapshot({
        baseUrl: savedBaseUrl,
        model: savedModel,
        providerId,
      });
      setSavedFlashFor(providerId);
      // PanelComposer seeds its model picker from the UI store.
      // This mirrors picking a model from the workbench composer, so the next
      // new session carries this explicit choice even before /api/model/info
      // finishes refetching.
      rememberLastUsedModel({
        model: savedModel,
        provider: providerId,
        providerName,
      });
    } catch (error) {
      setProviderSaveError(error instanceof Error ? error.message : String(error || "设置失败"));
    } finally {
      const elapsed = performance.now() - pendingStartedAt;
      if (elapsed < PROVIDER_ACTION_LOADING_MIN_MS) {
        await wait(PROVIDER_ACTION_LOADING_MIN_MS - elapsed);
      }
      setProviderSetCurrentPending(false);
    }
  };

  const handleAddCustom = () => {
    if (!config) return;
    const name = customForm.name.trim();
    const baseUrl = customForm.baseUrl.trim();
    const model = customForm.model.trim();
    const apiKey = customForm.apiKey.trim();
    if (!name || !baseUrl || !model) return;
    const host = baseUrl.match(/https?:\/\/([^/]+)/)?.[1] ?? "endpoint";
    const slug = host.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "");
    const existingIds = new Set(allProviders.map((p) => p.id));
    let candidate = `custom:${slug || "endpoint"}`;
    let suffix = 2;
    while (existingIds.has(candidate)) {
      candidate = `custom:${slug || "endpoint"}-${suffix++}`;
    }
    const preset: ProviderPreset = {
      id: candidate,
      name,
      vendor: customProviderMode === "local" ? "本地部署" : "自定义",
      region: "cn",
      baseUrl,
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "API Key",
      defaultModel: model,
      models: [{ id: model, supportsTools: true }],
      isCustom: true,
    };
    saveConfig.mutate(
      buildProviderConfigUpdate(config, preset, { apiKey, baseUrl, model }),
      {
        onSuccess: () => {
          selectProvider(candidate);
          closeCustomForm();
          setProviderForm({ apiKey: "", baseUrl, model });
        },
      },
    );
  };

  const handleSaveAuxiliaryTask = async () => {
    if (!config) return;
    setAuxSavingTask(selectedAuxTask);
    setAuxSavedTask(null);
    setAuxError("");
    try {
      await saveConfig.mutateAsync(buildAuxiliaryTaskUpdate(config, selectedAuxTask, auxForm));
      setAuxForm((prev) => ({ ...prev, apiKey: "" }));
      setAuxSavedTask(selectedAuxTask);
    } catch (error) {
      setAuxError(error instanceof Error ? error.message : String(error || "保存失败"));
    } finally {
      setAuxSavingTask(null);
    }
  };

  const handleResetAuxiliaryTask = async (task: AuxiliaryTaskId) => {
    if (!config) return;
    setAuxSavingTask(task);
    setAuxSavedTask(null);
    setAuxError("");
    try {
      await saveConfig.mutateAsync(buildAuxiliaryTaskReset(config, task));
      setAuxSavedTask(task);
    } catch (error) {
      setAuxError(error instanceof Error ? error.message : String(error || "恢复失败"));
    } finally {
      setAuxSavingTask(null);
    }
  };

  const handleResetAllAuxiliary = async () => {
    if (!config) return;
    setAuxSavingTask("__all__");
    setAuxSavedTask(null);
    setAuxError("");
    try {
      await saveConfig.mutateAsync(buildAllAuxiliaryReset(config));
      setAuxSavedTask("__all__");
    } catch (error) {
      setAuxError(error instanceof Error ? error.message : String(error || "恢复失败"));
    } finally {
      setAuxSavingTask(null);
    }
  };

  const handleImageInputModeChange = async (mode: "auto" | "native" | "text") => {
    if (!config) return;
    setAuxSavingTask("image_mode");
    setAuxSavedTask(null);
    setAuxError("");
    try {
      await saveConfig.mutateAsync(buildImageInputModeUpdate(config, mode));
      setAuxSavedTask("image_mode");
    } catch (error) {
      setAuxError(error instanceof Error ? error.message : String(error || "保存失败"));
    } finally {
      setAuxSavingTask(null);
    }
  };

  const envRowProps = (key: string, info: EnvVarInfo) => ({
    envKey: key,
    info,
    revealedValue: revealedValues[key],
    isEditing: editKey === key,
    editVal,
    onEdit: () => { setEditKey(key); setEditVal(""); },
    onEditChange: setEditVal,
    onSave: () => handleSave(key),
    onCancel: () => setEditKey(null),
    onReveal: () => handleReveal(key),
    onDelete: () => deleteEnv.mutate(key),
  });

  if (isLoading || configLoading) return <div className={s.desc}>加载中…</div>;
  if (!envVars || !config) return null;

  const needsInitialModelSetup = !modelInfo?.model?.trim() || !modelInfo?.provider?.trim() || configuredCount === 0;
  const customProviderIsLocal = customProviderMode === "local";
  const customProviderTitle = customProviderIsLocal ? "添加本地部署服务商" : "添加自定义服务商";
  const customProviderHint = customProviderIsLocal
    ? "适合 LM Studio、Ollama、vLLM、llama.cpp 等本地 OpenAI 兼容服务。先启动本地服务并加载模型，再选择下面的端点或手动填写。"
    : "添加任意 OpenAI Chat Completions 兼容服务（百度千帆 / 腾讯混元 / SiliconFlow / 私有部署等）。提交后可在左侧列表里随时切换。";
  const customProviderPlaceholders = customProviderIsLocal
    ? {
        name: "例如：LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "qwen2.5-coder:7b",
        apiKey: "本地服务一般可留空，启用鉴权时再填写",
      }
    : {
        name: "例如：Deepseek",
        baseUrl: "https://api.example.com/v1",
        model: "deepseek-v4-flash",
        apiKey: "可选，先建后填也可以",
      };

  return (
    <div className={s.modelsSettings}>
      {needsInitialModelSetup && (
        <div className={s.firstRunModelNotice}>
          <div>
            <strong>需要先完成模型初始化</strong>
            <p>
              当前独立 runtime 的 Hermes home 还没有可用模型。请选择一个服务商，粘贴 API Key，点击「保存配置」，再点击「设为当前模型」。
            </p>
          </div>
          <span>推荐从 DeepSeek 开始 · <a href="https://platform.deepseek.com/" target="_blank" rel="noreferrer" className={s.link}>DeepSeek 开放平台 ↗</a></span>
        </div>
      )}
      <div className={s.modelTopTabs} role="tablist" aria-label="模型配置类型">
        <button
          type="button"
          className={s.modelTopTab}
          data-active={activeModelTab === "main"}
          role="tab"
          aria-selected={activeModelTab === "main"}
          onClick={() => setActiveModelTab("main")}
        >
          主模型
          {modelInfo?.model && <span>{modelInfo.model}</span>}
        </button>
        <button
          type="button"
          className={s.modelTopTab}
          data-active={activeModelTab === "auxiliary"}
          role="tab"
          aria-selected={activeModelTab === "auxiliary"}
          onClick={() => setActiveModelTab("auxiliary")}
        >
          辅助模型
          <span>{configuredAuxiliaryCount} 项已指定</span>
        </button>
      </div>

      {activeModelTab === "main" ? (
        <>
          <div className={s.modelsSectionHeader}>
            <div>
              <p className={s.desc}>
                管理国内模型服务商预设和 API Key。
                {modelInfo && <> 当前模型: <b>{modelInfo.model}</b> ({modelInfo.provider})</>}
                {" · "}{configuredCount}/{catalog.providers.length} 个预设已配置
              </p>
            </div>
            <div className={s.catalogMeta}>
              <span>提供商目录 {catalog.version}</span>
              {catalogMessage && <span className={s.catalogMessage}>{catalogMessage}</span>}
            </div>
          </div>

          <div className={s.providerPresetLayout}>
            <div className={s.providerPresetListPane}>
              <div className={s.providerListToolbar}>
                <input
                  className={s.providerSearchInput}
                  value={providerSearch}
                  onChange={(event) => setProviderSearch(event.target.value)}
                  placeholder="搜索模型平台..."
                />
                <div className={s.providerToolbarActions}>
                  <button
                    className={s.btn}
                    onClick={() => openCustomProviderForm("custom")}
                    title="添加自定义 OpenAI 兼容服务商"
                  >
                    + 自定义
                  </button>
                  <button
                    className={s.btn}
                    onClick={() => openCustomProviderForm("local")}
                    title="添加本地部署 OpenAI 兼容服务商"
                  >
                    + 本地部署
                  </button>
                  <button className={s.btn} onClick={handleCatalogRefresh}>刷新预设</button>
                </div>
              </div>
              <div className={s.providerPresetList}>
                {filteredProviders.map((provider) => {
                  const configured = providerHasSavedCredentials(config, provider.id);
                  const current = currentProviderId === provider.id;
                  return (
                    <button
                      key={provider.id}
                      id={`provider-${provider.id}`}
                      className={s.providerPresetItem}
                      data-active={selectedProvider?.id === provider.id}
                      onClick={() => selectProvider(provider.id)}
                    >
                      <span className={s.providerPresetName}>{provider.name}</span>
                      <span className={s.providerPresetVendor}>{provider.vendor}</span>
                      <span className={s.providerPresetBadges}>
                        {current && <span className={s.statusBadge} data-on="true">当前</span>}
                        <span className={s.statusBadge} data-on={configured}>
                          {configured ? "已设置" : "未设置"}
                        </span>
                      </span>
                    </button>
                  );
                })}
                {filteredProviders.length === 0 && (
                  <div className={s.providerPresetEmpty}>没有匹配的模型平台</div>
                )}
              </div>
            </div>

            {selectedProvider && (
              <div className={s.providerPresetPanel} data-loading={providerPanelLoading}>
                {providerPanelLoading ? (
                  <ProviderPanelLoading providerName={selectedProvider.name} />
                ) : (
                  <>
                    <div className={s.providerPresetHeader}>
                      <div>
                        <div className={s.providerDetailName}>{selectedProvider.name}</div>
                        <div className={s.providerDetailVendor}>
                          {selectedProvider.id} · {selectedProvider.vendor}
                          {selectedProvider.docsUrl && <> · <a href={selectedProvider.docsUrl} target="_blank" rel="noreferrer" className={s.link}>文档 ↗</a></>}
                        </div>
                      </div>
                      <span className={s.statusBadge} data-on={selectedHasCredentials}>
                        {selectedHasCredentials ? "已保存密钥" : "未设置"}
                      </span>
                    </div>

                    <div className={s.providerFormGrid}>
                      <label className={s.fieldRow}>
                        <div className={s.fieldLabel}>{selectedProvider.apiKeyLabel}</div>
                        <input
                          className={s.fieldInput}
                          data-mono="true"
                          type="password"
                          value={providerForm.apiKey}
                          placeholder={
                            selectedHasCredentials
                              ? "已保存"
                              : selectedProviderCanOmitApiKey
                                ? "本地服务一般可留空"
                                : "粘贴 API Key"
                          }
                          onChange={(event) => setProviderForm((prev) => ({ ...prev, apiKey: event.target.value }))}
                        />
                      </label>
                      <label className={s.fieldRow}>
                        <div className={s.fieldLabel}>Base URL</div>
                        <input
                          className={s.fieldInput}
                          data-mono="true"
                          value={providerForm.baseUrl}
                          onChange={(event) => setProviderForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
                        />
                      </label>
                      <label className={s.fieldRow}>
                        <div className={s.fieldLabel}>模型</div>
                        <div className={s.modelPickerRow}>
                          <ModelCombobox
                            value={providerForm.model}
                            onChange={(next) => setProviderForm((prev) => ({ ...prev, model: next }))}
                            options={mergedModelOptions}
                          />
                          {supportsModelListing ? (
                            <button
                              type="button"
                              className={s.btn}
                              disabled={modelsQuery.isFetching}
                              onClick={() => modelsQuery.refetch()}
                              title={`从 ${providerForm.baseUrl}/models 拉取`}
                            >
                              {refreshLabel}
                            </button>
                          ) : null}
                        </div>
                      </label>
                      {!supportsModelListing && (
                        <div className={s.modelPickerHint}>此服务商不提供 /models 端点，使用预设模型或手动输入即可</div>
                      )}
                      {refreshErrorText && (
                        <div className={s.modelPickerError}>{refreshErrorText}</div>
                      )}
                    </div>

                    <div className={s.modelTags}>
                      {mergedModelOptions.slice(0, 8).map((id) => (
                        <span key={id} className={s.modelTag}>{id}</span>
                      ))}
                    </div>

                    <div className={s.providerActions}>
                      <button
                        className={s.btnPrimary}
                        disabled={
                          providerSavePending ||
                          providerSetCurrentPending ||
                          !isFormDirty ||
                          (!selectedHasCredentials && !providerForm.apiKey.trim() && !selectedProviderCanOmitApiKey)
                        }
                        onClick={() => void handleProviderSave()}
                      >
                        {providerSavePending
                          ? (
                            <>
                              <span className={s.buttonSpinner} aria-hidden="true" />
                              保存中…
                            </>
                          )
                          : showSavedFlash
                            ? "✓ 已保存"
                            : "保存配置"}
                      </button>
                      <button
                        className={isFormDirty || selectedProviderIsCurrent ? s.btn : s.btnPrimary}
                        disabled={
                          selectedProviderIsCurrent ||
                          providerSavePending ||
                          providerSetCurrentPending ||
                          !selectedProviderModel ||
                          (!selectedHasCredentials && !selectedProviderCanOmitApiKey)
                        }
                        onClick={() => void handleSetCurrentModel()}
                        title={
                          selectedProviderIsCurrent
                            ? "当前已在使用这个模型"
                            : selectedHasCredentials || selectedProviderCanOmitApiKey
                              ? "切换当前运行模型；如刚修改了 Base URL / API Key，请先保存配置"
                              : "请先保存 API Key / provider 配置"
                        }
                      >
                        {providerSetCurrentPending
                          ? (
                            <>
                              <span className={s.buttonSpinner} aria-hidden="true" />
                              切换中…
                            </>
                          )
                          : selectedProviderIsCurrent
                            ? "已是当前模型"
                            : "设为当前模型"}
                      </button>
                      <button
                        className={s.btn}
                        disabled={
                          probeForSelected?.status === "pending" ||
                          (!selectedHasCredentials && !providerForm.apiKey.trim())
                        }
                        onClick={() => void handleProbe()}
                        title="向 /models 端点发一次 GET，验证 API Key + 网络通"
                      >
                        {probeForSelected?.status === "pending" ? "测试中…" : "测试连接"}
                      </button>
                    </div>
                    {probeForSelected && probeForSelected.status !== "pending" && (
                      <ProbeResultRow probe={probeForSelected} />
                    )}
                    {providerSaveError && (
                      <div className={s.modelPickerError} style={{ marginTop: 8 }}>
                        操作失败：{providerSaveError}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <OAuthProvidersSection />

          <div className={s.advancedEnvBlock}>
            <button className={s.providerCardHeader} onClick={() => setShowEnvAdvanced((prev) => !prev)}>
              <span className={s.providerCardName}>
                <span className={s.providerCardArrow}>{showEnvAdvanced ? "▾" : "▸"}</span>
                高级环境变量
              </span>
              <span className={s.providerCardCount}>{providerEnvEntries.length} 项</span>
            </button>
            {showEnvAdvanced && (
              <div className={s.providerCardBody}>
                {providerEnvEntries.map(([key, info]) => (
                  <EnvRow key={key} {...envRowProps(key, info)} />
                ))}
              </div>
            )}
          </div>

          {nonProviderGroups.map((group) => (
            <div key={group.category} style={{ marginTop: 24 }}>
              <div className={s.modelsLabel}>{group.label} ({group.entries.length})</div>
              {group.entries.map(([key, info]) => (
                <EnvRow key={key} {...envRowProps(key, info)} />
              ))}
            </div>
          ))}
        </>
      ) : (
        <AuxiliaryModelsPanel
          config={config}
          modelInfo={modelInfo}
          providers={allProviders}
          providerOptions={auxiliaryProviderOptions}
          selectedTask={selectedAuxTask}
          form={auxForm}
          advancedOpen={auxAdvancedOpen}
          savingTask={auxSavingTask}
          savedTask={auxSavedTask}
          error={auxError}
          onSelectTask={setSelectedAuxTask}
          onFormChange={setAuxForm}
          onAdvancedOpenChange={setAuxAdvancedOpen}
          onSaveTask={() => void handleSaveAuxiliaryTask()}
          onResetTask={(task) => void handleResetAuxiliaryTask(task)}
          onResetAll={() => void handleResetAllAuxiliary()}
          imageInputMode={getImageInputMode(config)}
          onImageInputModeChange={(mode) => void handleImageInputModeChange(mode)}
        />
      )}

      {showCustomForm && createPortal(
        <div className={s.customProviderBackdrop} onClick={closeCustomForm}>
          <div
            className={s.customProviderModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby={customDialogTitleId}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={s.customProviderTitleBar}>
              <h2 id={customDialogTitleId}>{customProviderTitle}</h2>
              <button
                type="button"
                className={s.customProviderClose}
                onClick={closeCustomForm}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className={s.customProviderBody}>
              <p className={s.customProviderHint}>
                {customProviderHint}
              </p>
              {customProviderIsLocal && (
                <div className={s.localProviderGuide} aria-label="常用本地部署端点">
                  {LOCAL_PROVIDER_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      className={s.localProviderCard}
                      onClick={() => applyLocalProviderPreset(preset)}
                    >
                      <strong>{preset.name}</strong>
                      <code>{preset.baseUrl}</code>
                      <span>{preset.tutorial}</span>
                    </button>
                  ))}
                </div>
              )}
              <label className={s.fieldRow}>
                <div className={s.fieldLabel}>名称</div>
                <input
                  className={s.fieldInput}
                  value={customForm.name}
                  placeholder={customProviderPlaceholders.name}
                  autoFocus
                  onChange={(e) => setCustomForm((p) => ({ ...p, name: e.target.value }))}
                />
              </label>
              <label className={s.fieldRow}>
                <div className={s.fieldLabel}>Base URL</div>
                <input
                  className={s.fieldInput}
                  data-mono="true"
                  value={customForm.baseUrl}
                  placeholder={customProviderPlaceholders.baseUrl}
                  onChange={(e) => setCustomForm((p) => ({ ...p, baseUrl: e.target.value }))}
                />
              </label>
              <label className={s.fieldRow}>
                <div className={s.fieldLabel}>默认模型</div>
                <input
                  className={s.fieldInput}
                  data-mono="true"
                  value={customForm.model}
                  placeholder={customProviderPlaceholders.model}
                  onChange={(e) => setCustomForm((p) => ({ ...p, model: e.target.value }))}
                />
              </label>
              <label className={s.fieldRow}>
                <div className={s.fieldLabel}>API Key</div>
                <input
                  className={s.fieldInput}
                  data-mono="true"
                  type="password"
                  value={customForm.apiKey}
                  placeholder={customProviderPlaceholders.apiKey}
                  onChange={(e) => setCustomForm((p) => ({ ...p, apiKey: e.target.value }))}
                />
              </label>
            </div>
            <div className={s.customProviderActions}>
              <button type="button" className={s.btn} onClick={closeCustomForm}>取消</button>
              <button
                type="button"
                className={s.btnPrimary}
                disabled={
                  saveConfig.isPending ||
                  !customForm.name.trim() ||
                  !customForm.baseUrl.trim() ||
                  !customForm.model.trim()
                }
                onClick={handleAddCustom}
              >
                {saveConfig.isPending ? "保存中…" : "添加并选中"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function AuxiliaryModelsPanel({
  config,
  modelInfo,
  providers,
  providerOptions,
  selectedTask,
  form,
  advancedOpen,
  savingTask,
  savedTask,
  error,
  onSelectTask,
  onFormChange,
  onAdvancedOpenChange,
  onSaveTask,
  onResetTask,
  onResetAll,
  imageInputMode,
  onImageInputModeChange,
}: {
  config: Record<string, any>;
  modelInfo?: ModelInfo;
  providers: ProviderPreset[];
  providerOptions: { id: string; name: string; hint: string }[];
  selectedTask: AuxiliaryTaskId;
  form: AuxiliaryTaskForm;
  advancedOpen: boolean;
  savingTask: AuxiliaryTaskId | "__all__" | "image_mode" | null;
  savedTask: AuxiliaryTaskId | "__all__" | "image_mode" | null;
  error: string;
  onSelectTask: (task: AuxiliaryTaskId) => void;
  onFormChange: Dispatch<SetStateAction<AuxiliaryTaskForm>>;
  onAdvancedOpenChange: (open: boolean) => void;
  onSaveTask: () => void;
  onResetTask: (task: AuxiliaryTaskId) => void;
  onResetAll: () => void;
  imageInputMode: "auto" | "native" | "text";
  onImageInputModeChange: (mode: "auto" | "native" | "text") => void;
}) {
  const selectedDefinition = AUXILIARY_TASK_BY_ID[selectedTask];
  const modelOptions = getAuxiliaryModelOptions(form.provider, providers, form.model);
  const providerName = getProviderDisplayName(form.provider, providers);
  const selectedSlot = getAuxiliarySlot(config, selectedTask);
  const hasInlineApiKey = Boolean(selectedSlot.api_key);
  const isAutoProvider = form.provider === "auto";
  const isSavingCurrent = savingTask === selectedTask;
  const currentSaved = savedTask === selectedTask;
  const showVisionWarning = selectedTask === "vision" &&
    !isAutoProvider &&
    !isLikelyVisionCapable(form.provider, form.model, providers);
  const showVisionAutoHint = selectedTask === "vision" && isAutoProvider;

  const updateForm = (patch: Partial<AuxiliaryTaskForm>) => {
    onFormChange((prev) => ({ ...prev, ...patch }));
  };

  return (
    <div className={s.auxModels}>
      <div className={s.auxIntroCard}>
        <div>
          <div className={s.auxIntroTitle}>辅助模型按任务生效</div>
          <p>
            这里配置的是 <b>auxiliary.&lt;task&gt;</b> 槽位。「自动」会优先复用主模型，再按后端策略 fallback；显式指定后，该任务会固定走选中的 provider/model。
          </p>
          {modelInfo?.model && (
            <p>
              当前主模型是 <b>{modelInfo.model}</b>（{modelInfo.provider || "未知 provider"}），辅助模型配置主要影响图片分析、上下文压缩、网页抽取、标题生成、审批和 MCP 路由。
            </p>
          )}
        </div>
        <div className={s.auxImageModeBox}>
          <label className={s.fieldRow}>
            <div className={s.fieldLabel}>图片输入模式</div>
            <select
              className={s.select}
              value={imageInputMode}
              disabled={savingTask === "image_mode"}
              onChange={(event) =>
                onImageInputModeChange(event.target.value as "auto" | "native" | "text")}
            >
              <option value="auto">自动 · 主模型支持图片时原生，否则走 vision</option>
              <option value="text">文本 · 始终先用 vision 分析成文字</option>
              <option value="native">原生 · 始终尝试原生传图</option>
            </select>
          </label>
          {savedTask === "image_mode" && <div className={s.auxSavedHint}>✓ 图片输入模式已保存</div>}
        </div>
      </div>

      <div className={s.auxToolbar}>
        <div className={s.desc}>
          常用任务默认展示，高级任务用于 Kanban、档案和 Skill 审查。session_search 已不再使用辅助 LLM，所以这里不展示。
        </div>
        <button
          type="button"
          className={s.btn}
          disabled={savingTask === "__all__"}
          onClick={onResetAll}
        >
          {savingTask === "__all__" ? "恢复中…" : "全部恢复为自动"}
        </button>
      </div>

      <div className={s.auxLayout}>
        <div className={s.auxTaskList} aria-label="辅助模型任务列表">
          <AuxiliaryTaskGroup
            title="常用辅助任务"
            tasks={AUXILIARY_TASKS.filter((task) => task.group === "common")}
            config={config}
            selectedTask={selectedTask}
            onSelectTask={onSelectTask}
          />
          <AuxiliaryTaskGroup
            title="高级辅助任务"
            tasks={AUXILIARY_TASKS.filter((task) => task.group === "advanced")}
            config={config}
            selectedTask={selectedTask}
            onSelectTask={onSelectTask}
          />
        </div>

        <div className={s.auxEditorPanel}>
          <div className={s.auxEditorHeader}>
            <div>
              <div className={s.auxEditorTitle}>{selectedDefinition.name}</div>
              <div className={s.auxEditorSubtitle}>{selectedDefinition.description}</div>
            </div>
            <span className={s.statusBadge} data-on={!isAutoProvider}>
              {isAutoProvider ? "自动" : providerName}
            </span>
          </div>

          <div className={s.providerFormGrid}>
            <label className={s.fieldRow}>
              <div className={s.fieldLabel}>服务商</div>
              <select
                className={s.select}
                value={form.provider}
                onChange={(event) => updateForm({
                  provider: event.target.value,
                  model: event.target.value === "auto" ? "" : form.model,
                })}
              >
                {providerOptions.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} · {provider.id}
                  </option>
                ))}
              </select>
              <div className={s.modelPickerHint}>
                {providerOptions.find((provider) => provider.id === form.provider)?.hint ||
                  "可以直接使用当前配置里的 provider。"}
              </div>
            </label>

            <label className={s.fieldRow}>
              <div className={s.fieldLabel}>模型</div>
              <ModelCombobox
                value={form.model}
                onChange={(next) => updateForm({ model: next })}
                options={modelOptions}
                placeholder={isAutoProvider ? "自动模式下不需要填写模型" : "搜索或输入辅助模型 ID"}
                disabled={isAutoProvider}
              />
            </label>

            <label className={s.fieldRow}>
              <div className={s.fieldLabel}>调用超时（秒）</div>
              <input
                className={s.fieldInput}
                data-mono="true"
                value={form.timeout}
                inputMode="numeric"
                onChange={(event) => updateForm({ timeout: event.target.value })}
              />
            </label>
          </div>

          {showVisionAutoHint && (
            <div className={s.auxNotice}>
              「自动」会尝试寻找可用视觉后端；如果没有 Anthropic、OpenRouter、Nous 或自定义视觉 endpoint 的可用凭据，主模型是 MiniMax/DeepSeek 这类文本模型时仍然无法真正读图。
            </div>
          )}
          {showVisionWarning && (
            <div className={s.auxWarning}>
              当前 provider/model 看起来不像视觉模型。`auxiliary.vision` 必须指向真实支持图片输入的后端，否则附件图片仍会读取失败。
            </div>
          )}

          <button
            type="button"
            className={s.auxAdvancedToggle}
            onClick={() => onAdvancedOpenChange(!advancedOpen)}
          >
            <span>{advancedOpen ? "▾" : "▸"}</span>
            高级设置
          </button>
          {advancedOpen && (
            <div className={s.auxAdvancedGrid}>
              <label className={s.fieldRow}>
                <div className={s.fieldLabel}>Base URL</div>
                <input
                  className={s.fieldInput}
                  data-mono="true"
                  value={form.baseUrl}
                  placeholder="可选，自定义 OpenAI-compatible endpoint"
                  disabled={isAutoProvider}
                  onChange={(event) => updateForm({ baseUrl: event.target.value })}
                />
              </label>
              <label className={s.fieldRow}>
                <div className={s.fieldLabel}>内联 API Key</div>
                <input
                  className={s.fieldInput}
                  data-mono="true"
                  type="password"
                  value={form.apiKey}
                  placeholder={hasInlineApiKey ? "已保存，留空则保留" : "可选，优先建议使用全局环境变量"}
                  disabled={isAutoProvider}
                  onChange={(event) => updateForm({ apiKey: event.target.value })}
                />
              </label>
              {selectedTask === "vision" && (
                <label className={s.fieldRow}>
                  <div className={s.fieldLabel}>图片下载超时（秒）</div>
                  <input
                    className={s.fieldInput}
                    data-mono="true"
                    value={form.downloadTimeout}
                    inputMode="numeric"
                    onChange={(event) => updateForm({ downloadTimeout: event.target.value })}
                  />
                </label>
              )}
              <label className={`${s.fieldRow} ${s.auxExtraBodyField}`}>
                <div className={s.fieldLabel}>extra_body JSON</div>
                <textarea
                  className={s.auxJsonArea}
                  value={form.extraBody}
                  placeholder={'例如：{\\n  "provider": { "sort": "throughput" }\\n}'}
                  onChange={(event) => updateForm({ extraBody: event.target.value })}
                />
              </label>
            </div>
          )}

          {error && <div className={s.modelPickerError}>操作失败：{error}</div>}
          {currentSaved && <div className={s.auxSavedHint}>✓ {selectedDefinition.name} 已保存</div>}
          {savedTask === "__all__" && <div className={s.auxSavedHint}>✓ 所有辅助任务已恢复为自动</div>}

          <div className={s.providerActions}>
            <button
              type="button"
              className={s.btnPrimary}
              disabled={isSavingCurrent}
              onClick={onSaveTask}
            >
              {isSavingCurrent ? "保存中…" : "保存此辅助任务"}
            </button>
            <button
              type="button"
              className={s.btn}
              disabled={savingTask === selectedTask}
              onClick={() => onResetTask(selectedTask)}
            >
              恢复为自动
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AuxiliaryTaskGroup({
  title,
  tasks,
  config,
  selectedTask,
  onSelectTask,
}: {
  title: string;
  tasks: AuxiliaryTaskDefinition[];
  config: Record<string, any>;
  selectedTask: AuxiliaryTaskId;
  onSelectTask: (task: AuxiliaryTaskId) => void;
}) {
  return (
    <section className={s.auxTaskGroup}>
      <div className={s.auxTaskGroupTitle}>{title}</div>
      {tasks.map((task) => {
        const summary = describeAuxiliarySlot(config, task.id);
        const isAuto = summary === "Auto";
        return (
          <button
            type="button"
            key={task.id}
            className={s.auxTaskItem}
            data-active={selectedTask === task.id}
            onClick={() => onSelectTask(task.id)}
          >
            <span className={s.auxTaskMain}>
              <span className={s.auxTaskName}>{task.name}</span>
              <span className={s.auxTaskDesc}>{task.shortName}</span>
            </span>
            <span className={s.auxTaskState} data-auto={isAuto}>
              {isAuto ? "自动" : summary}
            </span>
          </button>
        );
      })}
    </section>
  );
}

function EnvRow({ envKey, info, revealedValue, isEditing, editVal, onEdit, onEditChange, onSave, onCancel, onReveal, onDelete }: {
  envKey: string; info: EnvVarInfo; revealedValue?: string; isEditing: boolean; editVal: string;
  onEdit: () => void; onEditChange: (v: string) => void; onSave: () => void; onCancel: () => void; onReveal: () => void; onDelete: () => void;
}) {
  const translated = translateEnvVar(envKey, info);
  const showEnvKeyInSub = translated.label !== envKey;

  return (
    <div className={s.row}>
      <div className={s.rowLeft}>
        <div className={s.rowLabel}>{translated.label}</div>
        <div className={s.rowSub}>
          {showEnvKeyInSub && <>{envKey} · </>}
          {translated.description}
          {info.url && <> · <a href={info.url} target="_blank" rel="noreferrer" className={s.link}>获取 Key ↗</a></>}
          {info.tools.length > 0 && ` · 用于: ${info.tools.join(", ")}`}
        </div>
      </div>
      <div className={s.rowRight} style={{ gap: 6, flexWrap: "wrap", minWidth: 200 }}>
        {isEditing ? (
          <>
            <input className={s.input} data-mono type={info.is_password ? "password" : "text"} value={editVal} onChange={(e) => onEditChange(e.target.value)} placeholder="输入值…" style={{ width: 180 }} autoFocus />
            <button className={s.btnPrimary} onClick={onSave}>保存</button>
            <button className={s.btn} onClick={onCancel}>取消</button>
          </>
        ) : (
          <>
            <span className={`${s.statusBadge} ${s.envStatusBadge}`} data-on={info.is_set}>
              {info.is_set ? (revealedValue ?? info.redacted_value ?? "已设置") : "未设置"}
            </span>
            <button className={s.btn} onClick={onEdit}>{info.is_set ? "替换" : "设置"}</button>
            {info.is_set && info.is_password && (
              <button className={s.btn} onClick={onReveal}>{revealedValue ? "隐藏" : "查看"}</button>
            )}
            {info.is_set && <button className={s.btnDanger} onClick={onDelete}>删除</button>}
          </>
        )}
      </div>
    </div>
  );
}

function ProviderPanelLoading({ providerName }: { providerName: string }) {
  return (
    <div className={s.providerPanelLoading} role="status" aria-live="polite">
      <div className={s.providerPanelLoadingHeader}>
        <span className={s.providerPanelSpinner} aria-hidden="true" />
        <div>
          <div className={s.providerPanelLoadingTitle}>正在加载 {providerName}</div>
          <div className={s.providerPanelLoadingDesc}>正在同步配置、密钥状态和模型预设…</div>
        </div>
      </div>
      <div className={s.providerPanelSkeleton} aria-hidden="true">
        <span className={s.providerPanelSkeletonLine} data-width="long" />
        <span className={s.providerPanelSkeletonLine} data-width="full" />
        <span className={s.providerPanelSkeletonLine} data-width="full" />
        <span className={s.providerPanelSkeletonLine} data-width="medium" />
      </div>
    </div>
  );
}

function ProbeResultRow({ probe }: { probe: { status: "ok" | "error" | "pending"; result?: ProviderProbeResult; message?: string } }) {
  if (probe.status === "pending") return null;
  const result = probe.result;
  if (probe.status === "ok" && result?.ok) {
    return (
      <div className={s.desc} style={{ marginTop: 8 }}>
        ✓ 连接成功 · 延迟 {result.latency_ms}ms · 可用 {result.model_count} 个模型
        {result.sample_models.length > 0 && (
          <span style={{ marginLeft: 8, opacity: 0.7 }}>
            （示例：{result.sample_models.slice(0, 3).join("、")}）
          </span>
        )}
      </div>
    );
  }
  const errorText = result?.error || probe.message || "未知错误";
  const kindLabel: Record<string, string> = {
    auth: "API Key 被拒绝",
    timeout: "请求超时",
    http: "HTTP 错误",
    network: "网络不通",
    unknown: "未知错误",
  };
  const kind = result?.error_kind ? kindLabel[result.error_kind] ?? result.error_kind : "请求失败";
  return (
    <div className={s.desc} style={{ marginTop: 8, color: "var(--h-danger, #c44)" }}>
      ✗ {kind} · {errorText}
    </div>
  );
}
