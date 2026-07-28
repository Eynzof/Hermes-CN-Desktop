import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Brain,
  Check,
  CircleAlert,
  Image as ImageIcon,
  RotateCcw,
  Search,
  Sparkles,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import type { GatewayModelProvider, ModelOptionsResult } from "@hermes/protocol";
import {
  BUILTIN_PROVIDER_CATALOG,
  TOP5_PROVIDER_IDS,
  type ProviderCatalogModel,
  type ProviderPreset,
} from "@/lib/provider-catalog";
import {
  rankRecentModels,
  readModelUsageLog,
  subscribeModelUsage,
  type ModelUsageEntry,
} from "@/lib/model-usage-log";
import { expandSearchQuery } from "@/lib/model-search-aliases";
import { getProviderIconUrl } from "@/lib/provider-icons";
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
): string {
  return picker?.selected?.model || options?.model || picker?.label || "切换模型";
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate model
// ─────────────────────────────────────────────────────────────────────────────

type CapabilityKey = "vision" | "tools" | "reasoning" | "longContext";

interface Candidate {
  key: string;
  catalogId: string;
  providerSlug: string;
  providerName: string;
  vendor: string;
  model: string;
  baseUrl?: string;
  apiKeyLabel?: string;
  iconUrl?: string;
  configured: boolean;
  caps: ProviderCatalogModel | null;
  warning?: string;
}

interface CapDescriptor {
  key: CapabilityKey;
  label: string;
  Icon: typeof ImageIcon;
  match: (caps: ProviderCatalogModel | null) => boolean;
}

const CAPABILITIES: CapDescriptor[] = [
  { key: "vision", label: "视觉", Icon: ImageIcon, match: (c) => Boolean(c?.supportsVision) },
  { key: "tools", label: "工具调用", Icon: Wrench, match: (c) => Boolean(c?.supportsTools) },
  { key: "reasoning", label: "深度推理", Icon: Brain, match: (c) => Boolean(c?.supportsReasoning) },
  {
    key: "longContext",
    label: "≥ 128K 上下文",
    Icon: Zap,
    match: (c) => (c?.contextWindow ?? 0) >= 128_000,
  },
];

type GroupKey = "recent" | "configured" | "recommended" | "moa" | "more";

const GROUP_LABELS: Record<GroupKey, { name: string; subtitle: string }> = {
  recent: { name: "最近", subtitle: "近 7 日使用过的模型" },
  configured: { name: "可用", subtitle: "已完成配置，可直接切换" },
  recommended: { name: "推荐接入", subtitle: "常用模型平台，配置后即可使用" },
  moa: { name: "MoA", subtitle: "多模型协作预设" },
  more: { name: "更多平台", subtitle: "其他可接入的模型平台" },
};

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
  return CATALOG_BY_ID.get(slug) ?? CATALOG_BY_ID.get(SLUG_ALIASES[slug] ?? "");
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function buildCandidates(
  modelOptions: ModelOptionsResult | null,
  usageEntries: ModelUsageEntry[],
): { all: Candidate[]; recent: Candidate[]; configured: Candidate[]; recommended: Candidate[]; moa: Candidate[]; more: Candidate[] } {
  const all: Candidate[] = [];
  const moa: Candidate[] = [];
  const seenKeys = new Set<string>();
  const gatewayProviderSlugs = new Set<string>();
  const gatewayCatalogIds = new Set<string>();

  // 1. From gateway model.options
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
    gatewayProviderSlugs.add(provider.slug);
    const preset = findCatalog(provider.slug);
    if (preset) gatewayCatalogIds.add(preset.id);
    const extras = asRecord(provider);
    const advertisedModels = provider.models ?? [];
    // Older Core versions did not always return `authenticated`, while a
    // non-empty model list already means this provider is selectable.
    const authenticated = Boolean(extras.authenticated) || advertisedModels.length > 0;
    const keyEnv = typeof extras.key_env === "string" ? extras.key_env : undefined;
    const warning = typeof extras.warning === "string" ? extras.warning : undefined;
    const catalogModelIds = preset?.models.map((model) => model.id) ?? [];
    if (advertisedModels.length === 0 && !authenticated) {
      // Unconfigured provider with no advertised models — still emit catalog
      // candidates so the default model can surface in 推荐预设 while newer
      // non-default models remain searchable in 更多.
      const placeholders = catalogModelIds.length > 0
        ? catalogModelIds
        : preset?.defaultModel
          ? [preset.defaultModel]
          : [];
      for (const placeholder of placeholders) {
        const key = `${provider.slug}:${placeholder}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          all.push({
            key,
            catalogId: preset?.id ?? provider.slug,
            providerSlug: provider.slug,
            providerName: preset?.name ?? providerLabel(provider),
            vendor: preset?.vendor ?? "",
            model: placeholder,
            baseUrl: preset?.baseUrl,
            apiKeyLabel: preset?.apiKeyLabel ?? keyEnv,
            iconUrl: getProviderIconUrl(preset?.icon),
            configured: false,
            caps: findModelCaps(preset, placeholder),
            warning,
          });
        }
      }
      continue;
    }
    const models = mergeModelIds(catalogModelIds, advertisedModels);
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
        baseUrl: preset?.baseUrl,
        apiKeyLabel: preset?.apiKeyLabel ?? keyEnv,
        iconUrl: getProviderIconUrl(preset?.icon),
        configured: authenticated,
        caps: findModelCaps(preset, modelId),
        warning,
      });
    }
  }

  // 2. From catalog Top 5: ensure they have catalog candidates even if the
  // gateway never returned them. This guarantees the 推荐预设 group is
  // populated for users with zero configured providers, while non-default
  // variants remain searchable in 更多.
  for (const topId of TOP5_PROVIDER_IDS) {
    if (gatewayProviderSlugs.has(topId) || gatewayCatalogIds.has(topId)) continue;
    const preset = CATALOG_BY_ID.get(topId);
    if (!preset) continue;
    for (const model of preset.models) {
      const key = `${topId}:${model.id}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      all.push({
        key,
        catalogId: preset.id,
        providerSlug: topId,
        providerName: preset.name,
        vendor: preset.vendor,
        model: model.id,
        baseUrl: preset.baseUrl,
        apiKeyLabel: preset.apiKeyLabel,
        iconUrl: getProviderIconUrl(preset.icon),
        configured: false,
        caps: model,
      });
    }
  }

  // 3. Group buckets
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

  // 推荐: unconfigured + in Top 5 + showing only the provider's default model
  // (don't dump every model variant into recommended — it'd look the same as
  // 更多 and bury the actual choices).
  const recommendedSeen = new Set<string>();
  const recommended: Candidate[] = [];
  for (const c of all) {
    if (c.configured) continue;
    if (!topSet.has(c.catalogId)) continue;
    if (recommendedSeen.has(c.catalogId)) continue;
    const preset = CATALOG_BY_ID.get(c.catalogId);
    if (preset && c.model !== preset.defaultModel) continue;
    recommendedSeen.add(c.catalogId);
    recommended.push(c);
  }

  const placed = new Set<string>([
    ...recent.map((c) => c.key),
    ...configured.map((c) => c.key),
    ...recommended.map((c) => c.key),
  ]);
  const more: Candidate[] = all.filter((c) => !placed.has(c.key));

  return { all, recent, configured, recommended, moa, more };
}

function candidateMatchesQuery(c: Candidate, expandedQuery: string): boolean {
  if (!expandedQuery) return true;
  const capabilityTerms = capabilityChips(c.caps).map((chip) => chip.label);
  const haystack = [
    c.model,
    c.providerName,
    c.vendor,
    c.providerSlug,
    c.apiKeyLabel,
    ...capabilityTerms,
    c.caps?.supportsTools ? "工具调用" : "",
    c.caps?.supportsReasoning ? "深度推理" : "",
    c.caps?.supportsVision ? "视觉" : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  // Expanded query is space-separated alternatives (raw + CN-alias
  // expansions). Match if ANY token hits — so typing "千问" finds qwen
  // models without forcing the user to know the English slug.
  const tokens = expandedQuery.split(/\s+/).filter(Boolean);
  return tokens.some((token) => haystack.includes(token));
}

function candidateMatchesCaps(c: Candidate, activeCaps: Set<CapabilityKey>): boolean {
  if (activeCaps.size === 0) return true;
  for (const key of activeCaps) {
    const cap = CAPABILITIES.find((x) => x.key === key);
    if (cap && !cap.match(c.caps)) return false;
  }
  return true;
}

function capabilityChips(caps: ProviderCatalogModel | null): { key: string; label: string; Icon: typeof ImageIcon }[] {
  if (!caps) return [];
  const chips: { key: string; label: string; Icon: typeof ImageIcon }[] = [];
  if (caps.contextWindow) {
    chips.push({
      key: "ctx",
      label: caps.contextWindow >= 1_000_000
        ? `${Math.round(caps.contextWindow / 1_000_000)}M`
        : `${Math.round(caps.contextWindow / 1_000)}K`,
      Icon: Zap,
    });
  }
  if (caps.supportsTools) chips.push({ key: "tools", label: "工具", Icon: Wrench });
  if (caps.supportsReasoning) chips.push({ key: "reasoning", label: "推理", Icon: Brain });
  if (caps.supportsVision) chips.push({ key: "vision", label: "视觉", Icon: ImageIcon });
  return chips;
}

function formatUsageMeta(entry: ModelUsageEntry | undefined, now = Date.now()): string {
  if (!entry) return "";
  const ageMs = Math.max(0, now - entry.lastUsedAt);
  const minutes = Math.floor(ageMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  let when: string;
  if (minutes < 1) when = "刚刚用过";
  else if (minutes < 60) when = `${minutes} 分钟前用过`;
  else if (hours < 24) when = `${hours} 小时前用过`;
  else if (days < 7) when = `${days} 天前用过`;
  else when = "7 天前用过";
  return entry.count > 1 ? `${when} · 累计 ${entry.count} 次` : when;
}

// ─────────────────────────────────────────────────────────────────────────────
// View components
// ─────────────────────────────────────────────────────────────────────────────

interface ModelPickerViewProps {
  modelSearch: string;
  onSearchChange: (value: string) => void;
  loading: boolean;
  error: string;
  modelOptions: ModelOptionsResult | null;
  /** Caller's currently-selected model (typically session-scoped). Used to
   * mark the "当前" badge inside the picker. Falls back to modelOptions
   * (gateway-level active model) when not provided. */
  selected?: ComposerModelSelection | null;
  switchingModel: boolean;
  onSelectModel: (selection: ComposerModelSelection) => void;
  /** ⌘↵ variant — set this model AND make it the global default. Picker
   * fires this when meta/ctrl is held during click; falls back to
   * onSelectModel when unset. */
  onSelectAndSetDefault?: (selection: ComposerModelSelection) => void;
  /** When a user clicks an unconfigured-provider CTA, the host route navigates
   * to /models with the provider id so the settings page can scroll to + focus
   * the relevant section. */
  onConfigureProvider?: (providerId: string) => void;
}

interface ModelPickerPanelProps extends ModelPickerViewProps {
  onClose: () => void;
}

interface ModelPickerBodyProps extends ModelPickerViewProps {
  searchInputRef?: RefObject<HTMLInputElement | null>;
  closeControl?: ReactNode;
}

function ModelPickerBody({
  modelSearch,
  onSearchChange,
  loading,
  error,
  modelOptions,
  selected,
  switchingModel,
  onSelectModel,
  onSelectAndSetDefault,
  onConfigureProvider,
  searchInputRef,
  closeControl,
}: ModelPickerBodyProps) {
  const [usageEntries, setUsageEntries] = useState<ModelUsageEntry[]>(() => {
    if (typeof window === "undefined") return [];
    return readModelUsageLog();
  });
  const [activeGroup, setActiveGroup] = useState<"all" | GroupKey>("all");
  const [activeCaps, setActiveCaps] = useState<Set<CapabilityKey>>(new Set());

  useEffect(() => {
    if (typeof window === "undefined") return;
    return subscribeModelUsage(() => setUsageEntries(readModelUsageLog()));
  }, []);

  const buckets = useMemo(
    () => buildCandidates(modelOptions, usageEntries),
    [modelOptions, usageEntries],
  );

  const query = expandSearchQuery(modelSearch);
  const usageByKey = useMemo(() => {
    const map = new Map<string, ModelUsageEntry>();
    for (const e of usageEntries) map.set(e.key, e);
    return map;
  }, [usageEntries]);

  const currentSelection = useMemo(() => {
    const model = selected?.model ?? modelOptions?.model;
    const provider = selected?.provider ?? modelOptions?.provider;
    if (!model) return null;
    const candidates = [...buckets.all, ...buckets.moa];
    const candidate = provider
      ? candidates.find((item) => item.key === `${provider}:${model}`)
      : candidates.find((item) => item.model === model);
    return {
      key: candidate?.key ?? `${provider ?? ""}:${model}`,
      model,
      provider: candidate?.providerName ?? provider ?? "",
    };
  }, [buckets, selected, modelOptions]);

  const warnings = useMemo(() => {
    const unique = new Set<string>();
    for (const candidate of buckets.all) {
      if (candidate.warning?.trim()) unique.add(candidate.warning.trim());
    }
    return [...unique];
  }, [buckets.all]);

  const filterGroup = useCallback(
    (group: Candidate[]) =>
      group.filter((c) => candidateMatchesQuery(c, query) && candidateMatchesCaps(c, activeCaps)),
    [query, activeCaps],
  );

  const visible = useMemo(() => {
    const recent = filterGroup(buckets.recent);
    const configured = filterGroup(buckets.configured);
    const recommended = filterGroup(buckets.recommended);
    const moa = filterGroup(buckets.moa);
    const more = filterGroup(buckets.more);
    return { recent, configured, recommended, moa, more };
  }, [buckets, filterGroup]);

  const recentVisibleKeys = useMemo(
    () => new Set(visible.recent.map((candidate) => candidate.key)),
    [visible.recent],
  );
  const configuredForDisplay = activeGroup === "all"
    ? visible.configured.filter((candidate) => !recentVisibleKeys.has(candidate.key))
    : visible.configured;
  const totalVisible = useMemo(() => new Set([
    ...visible.recent,
    ...visible.configured,
    ...visible.recommended,
    ...visible.moa,
    ...visible.more,
  ].map((candidate) => candidate.key)).size, [visible]);
  const activeVisibleCount = activeGroup === "all" ? totalVisible : visible[activeGroup].length;

  function toggleCap(cap: CapabilityKey) {
    setActiveCaps((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  }

  const showGroup = useCallback(
    (group: GroupKey): boolean => activeGroup === "all" || activeGroup === group,
    [activeGroup],
  );

  function clearFilters() {
    setActiveGroup("all");
    setActiveCaps(new Set());
    onSearchChange("");
  }

  function renderProviderMark(candidate: Candidate) {
    return (
      <span className={s.mpProviderMark} aria-hidden="true">
        {candidate.iconUrl ? (
          <img src={candidate.iconUrl} alt="" />
        ) : (
          <span>{(candidate.providerName || candidate.providerSlug).slice(0, 1).toUpperCase()}</span>
        )}
      </span>
    );
  }

  function renderRow(candidate: Candidate) {
    const isCurrent = candidate.key === currentSelection?.key;
    const usage = usageByKey.get(candidate.key);
    const caps = capabilityChips(candidate.caps);
    const baseUrlHost = candidate.baseUrl ? candidate.baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : "";

    return (
      <button
        key={candidate.key}
        type="button"
        className={s.mpRow}
        data-current={isCurrent ? "true" : undefined}
        data-unconfigured={candidate.configured ? undefined : "true"}
        disabled={switchingModel}
        aria-label={candidate.configured
          ? `切换到 ${candidate.providerName} 的 ${candidate.model}`
          : `配置 ${candidate.providerName}`}
        title={candidate.configured
          ? "单击切换当前会话 · 按住 ⌘ 单击同时设为全局默认"
          : `前往模型设置配置 ${candidate.providerName}`}
        onClick={(event) => {
          if (!candidate.configured) {
            onConfigureProvider?.(candidate.providerSlug);
            return;
          }
          const selection = {
            model: candidate.model,
            provider: candidate.providerSlug,
            providerName: candidate.providerName,
            contextWindow: candidate.caps?.contextWindow,
          };
          const setAsDefault = event.metaKey || event.ctrlKey;
          if (setAsDefault && onSelectAndSetDefault) {
            onSelectAndSetDefault(selection);
          } else {
            onSelectModel(selection);
          }
        }}
      >
        {renderProviderMark(candidate)}
        <div className={s.mpRowIdentity}>
          <div className={s.mpRowTitle}>
            <span>{candidate.model}</span>
            {isCurrent && <span className={s.mpCurrentBadge}><Check aria-hidden="true" />当前</span>}
          </div>
          <div className={s.mpRowMeta}>
            <span>{candidate.providerName}</span>
            <span className={s.mpMetaDot}>·</span>
            <span>{candidate.providerSlug}</span>
            {baseUrlHost && <><span className={s.mpMetaDot}>·</span><span>{baseUrlHost}</span></>}
            {!candidate.configured && candidate.apiKeyLabel && (
              <><span className={s.mpMetaDot}>·</span><span className={s.mpKeyLabel}>需要 {candidate.apiKeyLabel}</span></>
            )}
            {usage && <><span className={s.mpMetaDot}>·</span><RotateCcw aria-hidden="true" />{formatUsageMeta(usage)}</>}
          </div>
        </div>
        {caps.length > 0 && (
          <div className={s.mpRowCaps}>
            {caps.map(({ key, label, Icon }) => (
              <span key={key} className={s.mpCapChip}>
                <Icon aria-hidden="true" />
                {label}
              </span>
            ))}
          </div>
        )}
        <span className={candidate.configured ? s.mpRowAction : s.mpRowSetup}>
          {candidate.configured ? (isCurrent ? "使用中" : "切换") : "去配置"}
          {!isCurrent && <ArrowRight aria-hidden="true" />}
        </span>
      </button>
    );
  }

  function renderSection(group: GroupKey, candidates: Candidate[]) {
    if (!showGroup(group) || candidates.length === 0) return null;
    return (
      <section className={s.mpGroup} key={group}>
        <header className={s.mpGroupHeader}>
          <span>{GROUP_LABELS[group].name}</span>
          <span className={s.mpGroupCount}>{candidates.length}</span>
          <span className={s.mpGroupSub}>{GROUP_LABELS[group].subtitle}</span>
        </header>
        <div className={s.mpRows}>{candidates.map(renderRow)}</div>
      </section>
    );
  }

  return (
    <>
      <div className={s.modelPanelHeader}>
        <div className={s.mpSearchBox}>
          <Search aria-hidden="true" />
          <input
            ref={searchInputRef}
            value={modelSearch}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="搜索模型、平台或能力"
            aria-label="搜索模型、平台或能力"
            className={s.modelSearch}
          />
          {modelSearch && (
            <button type="button" onClick={() => onSearchChange("")} aria-label="清空搜索">清除</button>
          )}
        </div>
        {closeControl}
      </div>

      <div className={s.mpCurrentBar}>
        <div>
          <span className={s.mpCurrentLabel}>当前会话</span>
          <strong>{currentSelection?.model || "尚未选择模型"}</strong>
          {currentSelection?.provider && <span>{currentSelection.provider}</span>}
        </div>
        <span className={s.mpSwitchHint}>单击切换当前会话 · ⌘ 单击同时设为默认</span>
      </div>

      {loading ? (
        <div className={s.modelEmpty}>加载模型…</div>
      ) : error ? (
        <div className={s.modelError}>{error}</div>
      ) : (
        <div className={s.mpLayout}>
          <div className={s.mpFilterBar}>
            <div className={s.mpGroupTabs} aria-label="模型分组">
              <button type="button" data-active={activeGroup === "all"} aria-pressed={activeGroup === "all"} onClick={() => setActiveGroup("all")}>
                <Sparkles aria-hidden="true" />全部 <span>{totalVisible}</span>
              </button>
              {(["configured", "recent", "recommended", "moa", "more"] as const).map((group) => (
                <button
                  key={group}
                  type="button"
                  data-active={activeGroup === group}
                  aria-pressed={activeGroup === group}
                  onClick={() => setActiveGroup(group)}
                >
                  {GROUP_LABELS[group].name}<span>{visible[group].length}</span>
                </button>
              ))}
            </div>
            <div className={s.mpCapabilityFilters} aria-label="模型能力">
              {CAPABILITIES.map((cap) => (
                <button
                  key={cap.key}
                  type="button"
                  data-active={activeCaps.has(cap.key)}
                  aria-pressed={activeCaps.has(cap.key)}
                  onClick={() => toggleCap(cap.key)}
                >
                  <cap.Icon aria-hidden="true" />{cap.label}
                </button>
              ))}
              {(activeCaps.size > 0 || modelSearch) && (
                <button type="button" className={s.mpClearFilters} onClick={clearFilters}>重置</button>
              )}
            </div>
          </div>

          <div className={s.mpCandidates}>
            {warnings.length > 0 && (
              <div className={s.mpWarnings}>
                {warnings.map((warning) => <div key={warning}><CircleAlert aria-hidden="true" />{warning}</div>)}
              </div>
            )}
            {activeVisibleCount === 0 ? (
              <div className={s.mpEmptyState}>
                <Search aria-hidden="true" />
                <strong>没有匹配的模型</strong>
                <span>换个关键词或清除能力筛选后再试。</span>
                {(activeCaps.size > 0 || modelSearch) && <button type="button" onClick={clearFilters}>清除筛选</button>}
              </div>
            ) : (
              <>
                {renderSection("recent", visible.recent)}
                {renderSection("configured", configuredForDisplay)}
                {renderSection("moa", visible.moa)}
                {renderSection("recommended", visible.recommended)}
                {renderSection("more", visible.more)}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function ModelPickerPanel({ onClose, ...props }: ModelPickerPanelProps) {
  return (
    <div className={s.modelPanel}>
      <ModelPickerBody
        {...props}
        closeControl={(
          <button type="button" className={s.modelClose} onClick={onClose} aria-label="关闭模型选择">
            ×
          </button>
        )}
      />
    </div>
  );
}

export function ModelPickerModal({ onClose, ...props }: ModelPickerPanelProps) {
  const titleId = useId();
  const modalRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    const focusTimer = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousActiveElement?.focus();
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={s.modelModalBackdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className={s.modelModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={s.modelModalTitleBar}>
          <h2 id={titleId}>切换模型</h2>
          <button
            type="button"
            className={s.modelModalClose}
            onClick={onClose}
            aria-label="关闭模型选择"
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <ModelPickerBody {...props} searchInputRef={searchInputRef} />
      </div>
    </div>,
    document.body,
  );
}
