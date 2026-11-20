import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, PencilLine, X } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import type { GatewayModelProvider, ModelOptionsResult } from "@hermes/protocol";
import {
  BUILTIN_PROVIDER_CATALOG,
  TOP5_PROVIDER_IDS,
  type ProviderCatalogModel,
  type ProviderPreset,
} from "@/lib/provider-catalog";
import {
  rankRecentModels,
  type ModelUsageEntry,
} from "@/lib/model-usage-log";
import { BRAND } from "@/lib/brand.generated";
import {
  isBrandAccountModel,
  isCurrentBrandAccountProvider,
} from "@/lib/brand-account-models";
import {
  isLegacyBrandModelProvider,
  savedCustomProviderIdsFromConfig,
} from "@/lib/model-provider-visibility";
import { getProviderIconUrl } from "@/lib/provider-icons";
import { useConfig } from "@/hooks/use-config";
import { accountModelNamesAtom } from "@/stores/auth";
import { openSettingsDialogAtom } from "@/stores/settings-dialog";
import type { ComposerModelPickerProps, ComposerModelSelection } from "./composer-types";
import s from "./goose-composer.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers (kept stable so the composer doesn't break)
// ─────────────────────────────────────────────────────────────────────────────

export function providerLabel(provider: GatewayModelProvider): string {
  return provider.name || provider.slug;
}

export function providerMatches(provider: GatewayModelProvider, query: string): boolean {
  if (!query) return true;
  const haystack = [
    provider.slug,
    provider.name,
    ...(provider.models ?? []),
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

export function modelMatches(model: string, query: string): boolean {
  return !query || model.toLowerCase().includes(query);
}

export function modelButtonText(
  picker: ComposerModelPickerProps | undefined,
  options: ModelOptionsResult | null,
  _groupingOptions: ModelGroupingOptions = {},
): string {
  const model = picker?.selected?.model || options?.model;
  if (!model) return picker?.label || "切换模型";
  return model;
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate model
// ─────────────────────────────────────────────────────────────────────────────

export interface Candidate {
  key: string;
  catalogId: string;
  iconUrl?: string;
  providerSlug: string;
  providerName: string;
  vendor: string;
  model: string;
  displayName?: string;
  subtitle?: string;
  baseUrl?: string;
  apiKeyLabel?: string;
  apiUrl?: string;
  configured: boolean;
  caps: ProviderCatalogModel | null;
  warning?: string;
}

// 虚拟 provider：MoA 预设以 `moa` provider 的模型形式出现在 model.options
// 里。对齐官方桌面端（model-menu-panel），它们不混入常规分桶，而是拆成
// 独立的「MoA 预设」组；选中即持久切换（"<preset> --provider moa"）。
export const MOA_PROVIDER_SLUG = "moa";

// Map of catalog id → preset for fast lookup.
const CATALOG_BY_ID = new Map<string, ProviderPreset>(
  BUILTIN_PROVIDER_CATALOG.providers.map((p) => [p.id, p]),
);

// Backend slug doesn't always match catalog id (kimi-for-coding / kimi-coding,
// volcengine-ark / ark, etc.). Best-effort alias map. Unknown slugs fall back
// to the gateway-provided name and an empty capability set.
const SLUG_ALIASES: Record<string, string> = {
  "kimi-coding": "kimi-for-coding",
  "kimi-coding-cn": "kimi-for-coding",
  ark: "volcengine-ark",
  qianfan: "baidu-qianfan",
  hunyuan: "tencent-hunyuan",
};

function findCatalog(slug: string): ProviderPreset | undefined {
  const normalizedSlug = slug.trim().toLowerCase();
  const catalogSlug = normalizedSlug.startsWith("custom:")
    ? normalizedSlug.slice("custom:".length)
    : normalizedSlug;
  return CATALOG_BY_ID.get(catalogSlug)
    ?? CATALOG_BY_ID.get(SLUG_ALIASES[catalogSlug] ?? "");
}

function mergeModelIds(...lists: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const id of list ?? []) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function findModelCaps(preset: ProviderPreset | undefined, modelId: string): ProviderCatalogModel | null {
  return preset?.models.find((m) => m.id === modelId) ?? null;
}

function resolveModelCaps(
  provider: GatewayModelProvider,
  preset: ProviderPreset | undefined,
  modelId: string,
): ProviderCatalogModel | null {
  const fallback = findModelCaps(preset, modelId);
  const metadata = provider.capabilities?.[modelId];
  if (!metadata) return fallback;

  const hasModelsDevMetadata = metadata.supports_tools !== undefined
    || metadata.supports_vision !== undefined
    || metadata.supports_pdf !== undefined
    || metadata.supports_audio !== undefined
    || metadata.supports_video !== undefined
    || metadata.supports_reasoning !== undefined
    || metadata.supports_reasoning_control !== undefined
    || metadata.open_weights !== undefined
    || metadata.context_window !== undefined;
  if (!hasModelsDevMetadata) return fallback;

  return {
    id: modelId,
    label: fallback?.label,
    contextWindow: metadata.context_window ?? fallback?.contextWindow,
    supportsVision: metadata.supports_vision ?? fallback?.supportsVision,
    supportsPdf: metadata.supports_pdf ?? fallback?.supportsPdf,
    supportsAudio: metadata.supports_audio ?? fallback?.supportsAudio,
    supportsVideo: metadata.supports_video ?? fallback?.supportsVideo,
    supportsTools: metadata.supports_tools ?? fallback?.supportsTools,
    supportsReasoning: metadata.supports_reasoning
      ?? metadata.reasoning
      ?? fallback?.supportsReasoning,
    supportsReasoningControl: metadata.supports_reasoning_control
      ?? fallback?.supportsReasoningControl,
    openWeights: metadata.open_weights ?? fallback?.openWeights,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function featuredModelIds(
  provider: GatewayModelProvider,
  preset: ProviderPreset | undefined,
  currentProvider: string | undefined,
  currentModel: string | undefined,
  limit: number,
): string[] {
  const catalogModels = preset?.models.map((model) => model.id) ?? [];
  const candidates = preset
    ? mergeModelIds(catalogModels, provider.models)
    : mergeModelIds(provider.models);
  const activeModel = provider.slug === currentProvider ? currentModel : undefined;

  if (activeModel && !candidates.includes(activeModel)) candidates.unshift(activeModel);
  const featured = candidates.slice(0, limit);
  if (activeModel && !featured.includes(activeModel)) {
    featured[featured.length - 1] = activeModel;
  }
  return featured;
}

export function buildCandidates(
  modelOptions: ModelOptionsResult | null,
  usageEntries: ModelUsageEntry[],
  limit = 5,
  modelNames: Readonly<Record<string, string>> = {},
): { all: Candidate[]; recent: Candidate[]; configured: Candidate[]; moa: Candidate[] } {
  const all: Candidate[] = [];
  const moa: Candidate[] = [];
  const seenKeys = new Set<string>();

  // model.options 默认只返回已经完成鉴权的供应商。兼容旧版 Core 时，
  // 没有 authenticated 字段但返回了模型的供应商仍视为可用；显式 false
  // 则必须排除，不能再把内置目录补成「去配置」占位卡片。
  for (const provider of modelOptions?.providers ?? []) {
    // MoA 预设走独立分组，不进常规分桶（对齐官方桌面端把 moa 行从
    // pickerProviders 里拆出的做法）。
    if (provider.slug.toLowerCase() === MOA_PROVIDER_SLUG) {
      for (const presetName of provider.models ?? []) {
        if (!presetName) continue;
        moa.push({
          key: `${MOA_PROVIDER_SLUG}:${presetName}`,
          catalogId: MOA_PROVIDER_SLUG,
          providerSlug: MOA_PROVIDER_SLUG,
          providerName: providerLabel(provider) || "Mixture of Agents",
          vendor: "MoA",
          model: presetName,
          configured: true,
          caps: null,
        });
      }
      continue;
    }
    const preset = findCatalog(provider.slug);
    const extras = asRecord(provider);
    const advertisedModels = provider.models ?? [];
    const authHint = extras.authenticated;
    const authenticated = authHint === true || (
      typeof authHint !== "boolean" && advertisedModels.length > 0
    );
    if (!authenticated) continue;

    const keyEnv = typeof extras.key_env === "string" ? extras.key_env : undefined;
    const warning = typeof extras.warning === "string" ? extras.warning : undefined;
    const apiUrl = typeof extras.api_url === "string"
      ? extras.api_url
      : typeof extras.apiUrl === "string" ? extras.apiUrl : undefined;
    const models = featuredModelIds(
      provider,
      preset,
      modelOptions?.provider,
      modelOptions?.model,
      limit,
    );
    for (const modelId of models) {
      const key = `${provider.slug}:${modelId}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      all.push({
        key,
        catalogId: preset?.id ?? provider.slug,
        providerSlug: provider.slug,
        providerName: preset?.name ?? providerLabel(provider),
        vendor: preset?.vendor ?? "",
        model: modelId,
        displayName: isCurrentBrandAccountProvider(provider.slug) ? modelNames[modelId] : undefined,
        baseUrl: preset?.baseUrl,
        apiKeyLabel: preset?.apiKeyLabel ?? keyEnv,
        iconUrl: getProviderIconUrl(preset?.icon),
        apiUrl,
        configured: authenticated,
        caps: resolveModelCaps(provider, preset, modelId),
        warning,
      });
    }
  }

  const usageRanked = rankRecentModels(usageEntries, { limit: 3 });

  const recent: Candidate[] = usageRanked
    .map((e) => all.find((c) => c.key === e.key))
    .filter((c): c is Candidate => Boolean(c));

  const topSet = new Set<string>(TOP5_PROVIDER_IDS);
  const configured: Candidate[] = all
    .filter((c) => c.configured)
    .sort((a, b) => {
      const aTop = topSet.has(a.catalogId) ? 0 : 1;
      const bTop = topSet.has(b.catalogId) ? 0 : 1;
      if (aTop !== bTop) return aTop - bTop;
      return a.providerName.localeCompare(b.providerName, "zh-Hans-CN");
    });

  return { all, recent, configured, moa };
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkBuddy 风格紧凑模型菜单（锚定在「模型」按钮上方）
// ─────────────────────────────────────────────────────────────────────────────

interface ModelMenuProps {
  loading: boolean;
  error: string;
  modelOptions: ModelOptionsResult | null;
  selected?: ComposerModelSelection | null;
  switchingModel: boolean;
  onSelectModel: (selection: ComposerModelSelection) => void;
  /** ⌘↵ variant — set this model AND make it the global default. */
  onSelectAndSetDefault?: (selection: ComposerModelSelection) => void;
  onClose: () => void;
  /** 模型按钮的 ref，用于把菜单锚定到按钮上方。 */
  anchorRef?: RefObject<HTMLElement | null>;
}

const CUSTOM_PROVIDER_PREFIX = "custom:";
export interface ModelGroups {
  custom: Candidate[];
  builtin: Candidate[];
}

function modelNameOrder(a: Candidate, b: Candidate): number {
  return a.model.localeCompare(b.model, "zh-Hans-CN");
}

export interface ModelGroupingOptions {
  savedCustomProviderIds?: ReadonlySet<string>;
}

export function groupCandidates(
  modelOptions: ModelOptionsResult | null,
  options: ModelGroupingOptions = {},
  modelNames: Readonly<Record<string, string>> = {},
): ModelGroups {
  const groups: ModelGroups = { custom: [], builtin: [] };
  const { all } = buildCandidates(modelOptions, [], Number.MAX_SAFE_INTEGER, modelNames);
  const otherBuiltinCandidates: Candidate[] = [];
  const seenBuiltinModels = new Set<string>();

  for (const candidate of all) {
    if (!candidate.configured) continue;
    const providerSlug = candidate.providerSlug.toLowerCase();
    if (providerSlug.startsWith("custom:acct-")) {
      // Account-backed models are provisioned managed providers, but they are
      // normal built-in choices only when they belong to the active brand.
      if (
        isCurrentBrandAccountProvider(providerSlug)
        && (isBrandAccountModel(candidate.model)
          || (BRAND.accountBackend === "ccwork" && BRAND.accountDefaultModels.length === 0))
        && !seenBuiltinModels.has(candidate.model)
      ) {
        seenBuiltinModels.add(candidate.model);
        otherBuiltinCandidates.push(candidate);
      }
    } else if (isLegacyBrandModelProvider(providerSlug)) {
      // Old desktop releases used custom:<brand> ids. Never surface account
      // providers from the current or another brand as user custom models.
      continue;
    } else if (providerSlug.startsWith(CUSTOM_PROVIDER_PREFIX)) {
      if (options.savedCustomProviderIds?.has(providerSlug) ?? true) {
        groups.custom.push(candidate);
      }
    }
  }

  groups.custom.sort(modelNameOrder);
  const brandOrder = new Map(BRAND.accountDefaultModels.map((model, index) => [model, index]));
  groups.builtin = otherBuiltinCandidates.sort((a, b) =>
    (brandOrder.get(a.model) ?? Number.MAX_SAFE_INTEGER)
      - (brandOrder.get(b.model) ?? Number.MAX_SAFE_INTEGER));
  return groups;
}

function CandidateIcon({ candidate }: { candidate: Candidate }) {
  const preset = findCatalog(candidate.providerSlug);
  const url = getProviderIconUrl(preset?.icon);
  if (url) {
    return <img className={s.modelMenuItemIcon} src={url} alt="" aria-hidden="true" />;
  }
  return (
    <span
      className={s.modelMenuItemIcon}
      data-tone="custom"
      aria-hidden="true"
    >
      {(candidate.displayName || candidate.model).trim()[0]?.toUpperCase() ?? "M"}
    </span>
  );
}

export function ModelPickerModal({
  loading,
  error,
  modelOptions,
  selected,
  switchingModel,
  onSelectModel,
  onSelectAndSetDefault,
  onClose,
  anchorRef,
}: ModelMenuProps) {
  const openSettingsDialog = useSetAtom(openSettingsDialogAtom);
  const modelNames = useAtomValue(accountModelNamesAtom);
  const { data: config } = useConfig();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ bottom: number; left: number } | null>(null);

  const savedCustomProviderIds = useMemo(
    () => savedCustomProviderIdsFromConfig(config),
    [config],
  );
  const groups = useMemo(
    () => groupCandidates(modelOptions, { savedCustomProviderIds }, modelNames),
    [modelOptions, savedCustomProviderIds, modelNames],
  );
  const isEmpty = groups.custom.length + groups.builtin.length === 0;

  const currentSelectionKey = useMemo(() => {
    const model = selected?.model ?? modelOptions?.model;
    const provider = selected?.provider ?? modelOptions?.provider;
    if (!model) return "";
    return `${provider ?? ""}:${model}`;
  }, [selected, modelOptions]);

  // 锚定到模型按钮上方；无锚点时兜底为底部居中。
  useEffect(() => {
    const MENU_WIDTH = 300;
    const rect = anchorRef?.current?.getBoundingClientRect();
    if (!rect) {
      setPosition(null);
      return;
    }
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 12));
    setPosition({ bottom: window.innerHeight - rect.top + 8, left });
  }, [anchorRef, modelOptions]);

  useEffect(() => {
    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousActiveElement?.focus();
    };
  }, [onClose]);

  const pick = (candidate: Candidate) => (event: React.MouseEvent) => {
    const selection: ComposerModelSelection = {
      model: candidate.model,
      provider: candidate.providerSlug,
      providerName: candidate.providerName,
      contextWindow: candidate.caps?.contextWindow,
    };
    if ((event.metaKey || event.ctrlKey) && onSelectAndSetDefault) {
      onSelectAndSetDefault(selection);
    } else {
      onSelectModel(selection);
    }
  };

  const renderGroup = (label: string, candidates: Candidate[]) => {
    if (candidates.length === 0) return null;
    return (
      <section>
        <div className={s.modelMenuGroup}>{label}</div>
        {candidates.map((candidate) => {
          const isCurrent = candidate.key === currentSelectionKey;
          return (
            <button
              key={candidate.key}
              type="button"
              className={s.modelMenuItem}
              data-current={isCurrent ? "true" : undefined}
              disabled={switchingModel}
              title="↵ 仅本会话 · ⌘↵ 同时设为全局默认"
              onClick={pick(candidate)}
            >
              <CandidateIcon candidate={candidate} />
              <span className={s.modelMenuItemText}>
                <span className={s.modelMenuItemName}>{candidate.displayName || candidate.model}</span>
                <span className={s.modelMenuItemProvider}>
                  {candidate.subtitle || candidate.providerName}
                </span>
              </span>
              {isCurrent ? <Check size={16} className={s.modelMenuItemCheck} aria-hidden="true" /> : null}
            </button>
          );
        })}
      </section>
    );
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={s.modelMenuBackdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={menuRef}
        className={s.modelMenu}
        role="dialog"
        aria-modal="true"
        aria-label="选择模型"
        style={position ? { bottom: position.bottom, left: position.left } : undefined}
        data-anchored={position ? "true" : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={s.modelMenuHead}>
          <span>选择模型</span>
          <button type="button" className={s.modelMenuClose} onClick={onClose} aria-label="关闭模型选择">
            <X size={12} aria-hidden="true" />
          </button>
        </div>

        <div className={s.modelMenuScroll}>
          {loading ? (
            <div className={s.modelMenuEmpty}>加载模型…</div>
          ) : error ? (
            <div className={s.modelMenuError}>{error}</div>
          ) : isEmpty ? (
            <div className={s.modelMenuEmpty}>暂无可用模型，请先在下方配置</div>
          ) : (
            <>
              {renderGroup("自定义模型", groups.custom)}
              {renderGroup("内置模型", groups.builtin)}
            </>
          )}
        </div>

        <div className={s.modelMenuFoot}>
          <button
            type="button"
            className={s.modelMenuItem}
            onClick={() => {
              onClose();
              openSettingsDialog("model");
            }}
          >
            <span className={s.modelMenuItemIcon} data-tone="custom" aria-hidden="true">
              <PencilLine size={12} />
            </span>
            <span className={s.modelMenuItemText}>
              <span className={s.modelMenuItemName}>配置自定义模型</span>
            </span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
