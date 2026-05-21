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
import { ArrowRight, Brain, Check, ChevronRight, Image as ImageIcon, RotateCcw, Sparkles, Wrench, X, Zap } from "lucide-react";
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
  providerSlug: string;
  providerName: string;
  vendor: string;
  model: string;
  baseUrl?: string;
  apiKeyLabel?: string;
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

type GroupKey = "recent" | "configured" | "recommended" | "more";

const GROUP_LABELS: Record<GroupKey, { name: string; subtitle: string }> = {
  recent: { name: "最近用过", subtitle: "按 7 日内调用次数排序" },
  configured: { name: "已配置", subtitle: "填了 Key 但本周未用" },
  recommended: { name: "推荐预设", subtitle: "Top 5 模型平台 · 一键跳设置页填 Key" },
  more: { name: "更多", subtitle: "全球 / 企业 / OAuth 类" },
};

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

function findModelCaps(preset: ProviderPreset | undefined, modelId: string): ProviderCatalogModel | null {
  return preset?.models.find((m) => m.id === modelId) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildCandidates(
  modelOptions: ModelOptionsResult | null,
  usageEntries: ModelUsageEntry[],
): { all: Candidate[]; recent: Candidate[]; configured: Candidate[]; recommended: Candidate[]; more: Candidate[] } {
  const all: Candidate[] = [];
  const seenKeys = new Set<string>();
  const gatewayProviderSlugs = new Set<string>();

  // 1. From gateway model.options
  for (const provider of modelOptions?.providers ?? []) {
    gatewayProviderSlugs.add(provider.slug);
    const preset = findCatalog(provider.slug);
    const extras = asRecord(provider);
    const authenticated = Boolean(extras.authenticated);
    const keyEnv = typeof extras.key_env === "string" ? extras.key_env : undefined;
    const warning = typeof extras.warning === "string" ? extras.warning : undefined;
    const models = provider.models ?? [];
    if (models.length === 0 && !authenticated) {
      // Unconfigured provider with no advertised models — still emit one
      // placeholder so the CTA card surfaces.
      const placeholder = preset?.defaultModel ?? "";
      if (placeholder) {
        const key = `${provider.slug}:${placeholder}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          all.push({
            key,
            providerSlug: provider.slug,
            providerName: preset?.name ?? providerLabel(provider),
            vendor: preset?.vendor ?? "",
            model: placeholder,
            baseUrl: preset?.baseUrl,
            apiKeyLabel: preset?.apiKeyLabel ?? keyEnv,
            configured: false,
            caps: findModelCaps(preset, placeholder),
            warning,
          });
        }
      }
      continue;
    }
    for (const modelId of models) {
      const key = `${provider.slug}:${modelId}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      all.push({
        key,
        providerSlug: provider.slug,
        providerName: preset?.name ?? providerLabel(provider),
        vendor: preset?.vendor ?? "",
        model: modelId,
        baseUrl: preset?.baseUrl,
        apiKeyLabel: preset?.apiKeyLabel ?? keyEnv,
        configured: authenticated,
        caps: findModelCaps(preset, modelId),
        warning,
      });
    }
  }

  // 2. From catalog Top 5: ensure they have at least their default model as
  // a candidate even if the gateway never returned them. This guarantees the
  // 推荐预设 group is populated for users with zero configured providers.
  for (const topId of TOP5_PROVIDER_IDS) {
    if (gatewayProviderSlugs.has(topId)) continue;
    const preset = CATALOG_BY_ID.get(topId);
    if (!preset) continue;
    for (const model of preset.models) {
      const key = `${topId}:${model.id}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      all.push({
        key,
        providerSlug: topId,
        providerName: preset.name,
        vendor: preset.vendor,
        model: model.id,
        baseUrl: preset.baseUrl,
        apiKeyLabel: preset.apiKeyLabel,
        configured: false,
        caps: model,
      });
    }
  }

  // 3. Group buckets
  const usageRanked = rankRecentModels(usageEntries, { limit: 3 });
  const usageKeySet = new Set(usageRanked.map((e) => e.key));

  const recent: Candidate[] = usageRanked
    .map((e) => all.find((c) => c.key === e.key))
    .filter((c): c is Candidate => Boolean(c));

  const topSet = new Set<string>(TOP5_PROVIDER_IDS);
  const configured: Candidate[] = all
    .filter((c) => c.configured && !usageKeySet.has(c.key))
    .sort((a, b) => {
      const aTop = topSet.has(a.providerSlug) ? 0 : 1;
      const bTop = topSet.has(b.providerSlug) ? 0 : 1;
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
    if (!topSet.has(c.providerSlug)) continue;
    if (recommendedSeen.has(c.providerSlug)) continue;
    const preset = CATALOG_BY_ID.get(c.providerSlug);
    if (preset && c.model !== preset.defaultModel) continue;
    recommendedSeen.add(c.providerSlug);
    recommended.push(c);
  }

  const placed = new Set<string>([
    ...recent.map((c) => c.key),
    ...configured.map((c) => c.key),
    ...recommended.map((c) => c.key),
  ]);
  const more: Candidate[] = all.filter((c) => !placed.has(c.key));

  return { all, recent, configured, recommended, more };
}

function candidateMatchesQuery(c: Candidate, expandedQuery: string): boolean {
  if (!expandedQuery) return true;
  const haystack = [c.model, c.providerName, c.vendor, c.providerSlug, c.apiKeyLabel]
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
  const [moreExpanded, setMoreExpanded] = useState(false);

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

  const currentSelectionKey = useMemo(() => {
    const model = selected?.model ?? modelOptions?.model;
    const provider = selected?.provider ?? modelOptions?.provider;
    if (!model) return "";
    return `${provider ?? ""}:${model}`;
  }, [selected, modelOptions]);

  const filterGroup = useCallback(
    (group: Candidate[]) =>
      group.filter((c) => candidateMatchesQuery(c, query) && candidateMatchesCaps(c, activeCaps)),
    [query, activeCaps],
  );

  const visible = useMemo(() => {
    const recent = filterGroup(buckets.recent);
    const configured = filterGroup(buckets.configured);
    const recommended = filterGroup(buckets.recommended);
    const more = filterGroup(buckets.more);
    return { recent, configured, recommended, more };
  }, [buckets, filterGroup]);

  const totalVisible = visible.recent.length + visible.configured.length + visible.recommended.length + visible.more.length;

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

  function renderCard(candidate: Candidate) {
    const isCurrent = candidate.key === currentSelectionKey;
    const usage = usageByKey.get(candidate.key);
    const caps = capabilityChips(candidate.caps);
    const baseUrlHost = candidate.baseUrl ? candidate.baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : "";

    if (!candidate.configured) {
      return (
        <button
          key={candidate.key}
          type="button"
          className={s.mpCard}
          data-unconfigured="true"
          onClick={() => onConfigureProvider?.(candidate.providerSlug)}
          disabled={switchingModel}
        >
          <div className={s.mpCardHead}>
            <span className={s.mpCardVendor}>{candidate.vendor || candidate.providerName}</span>
            <span className={s.mpCardName}>{candidate.model}</span>
            <span className={s.mpCardPillWarn}>未配置</span>
          </div>
          <div className={s.mpCardMeta}>
            <span>{candidate.providerName}</span>
            {candidate.apiKeyLabel && (
              <>
                <span className={s.mpCardSep}>·</span>
                <span>需要 <code className={s.mpCardMono}>{candidate.apiKeyLabel}</code></span>
              </>
            )}
          </div>
          {caps.length > 0 && (
            <div className={s.mpCardCaps}>
              {caps.map(({ key, label, Icon }) => (
                <span key={key} className={s.mpCapChip}>
                  <Icon aria-hidden="true" />
                  {label}
                </span>
              ))}
            </div>
          )}
          <div className={s.mpCardCta}>
            <ArrowRight aria-hidden="true" />
            去设置 · /models#{candidate.providerSlug}
          </div>
        </button>
      );
    }

    return (
      <button
        key={candidate.key}
        type="button"
        className={s.mpCard}
        data-current={isCurrent ? "true" : undefined}
        disabled={switchingModel}
        title="↵ 仅本会话 · ⌘↵ 同时设为全局默认"
        onClick={(event) => {
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
        {isCurrent && <span className={s.mpCardStrip} aria-hidden="true" />}
        <div className={s.mpCardHead}>
          <span className={s.mpCardVendor}>{candidate.vendor || candidate.providerName}</span>
          <span className={s.mpCardName}>{candidate.model}</span>
          {isCurrent && (
            <span className={s.mpCardPillOk}>
              <Check aria-hidden="true" /> 当前
            </span>
          )}
        </div>
        <div className={s.mpCardMeta}>
          <span>{candidate.providerName}</span>
          {baseUrlHost && (
            <>
              <span className={s.mpCardSep}>·</span>
              <span>{baseUrlHost}</span>
            </>
          )}
        </div>
        {caps.length > 0 && (
          <div className={s.mpCardCaps}>
            {caps.map(({ key, label, Icon }) => (
              <span key={key} className={s.mpCapChip}>
                <Icon aria-hidden="true" />
                {label}
              </span>
            ))}
          </div>
        )}
        {usage && (
          <div className={s.mpCardUsage}>
            <RotateCcw aria-hidden="true" />
            {formatUsageMeta(usage)}
          </div>
        )}
      </button>
    );
  }

  return (
    <>
      <div className={s.modelPanelHeader}>
        <input
          ref={searchInputRef}
          value={modelSearch}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="按名称、能力或厂商搜索 — 如 ‘128K’、‘视觉’、‘deepseek’"
          className={s.modelSearch}
        />
        {closeControl}
      </div>

      {loading ? (
        <div className={s.modelEmpty}>加载模型…</div>
      ) : error ? (
        <div className={s.modelError}>{error}</div>
      ) : (
        <div className={s.mpGrid}>
          <aside className={s.mpFilters}>
            <div className={s.mpFilterSection}>
              <div className={s.mpFilterTitle}>分组</div>
              <button
                type="button"
                className={s.mpFilterChip}
                data-active={activeGroup === "all"}
                onClick={() => setActiveGroup("all")}
              >
                <Sparkles aria-hidden="true" />
                全部
                <span className={s.mpFilterCount}>{totalVisible}</span>
              </button>
              {(["recent", "configured", "recommended", "more"] as const).map((group) => {
                const count = visible[group].length;
                return (
                  <button
                    key={group}
                    type="button"
                    className={s.mpFilterChip}
                    data-active={activeGroup === group}
                    onClick={() => setActiveGroup(group)}
                  >
                    {GROUP_LABELS[group].name}
                    <span className={s.mpFilterCount}>{count}</span>
                  </button>
                );
              })}
            </div>

            <div className={s.mpFilterSection}>
              <div className={s.mpFilterTitle}>能力</div>
              {CAPABILITIES.map((cap) => (
                <button
                  key={cap.key}
                  type="button"
                  className={s.mpFilterChip}
                  data-active={activeCaps.has(cap.key)}
                  onClick={() => toggleCap(cap.key)}
                >
                  <cap.Icon aria-hidden="true" />
                  {cap.label}
                </button>
              ))}
            </div>
          </aside>

          <div className={s.mpCandidates}>
            {totalVisible === 0 ? (
              <div className={s.modelEmpty}>没有匹配的模型</div>
            ) : (
              <>
                {showGroup("recent") && visible.recent.length > 0 && (
                  <section className={s.mpGroup}>
                    <header className={s.mpGroupHeader}>
                      <span>{GROUP_LABELS.recent.name}</span>
                      <span className={s.mpGroupSub}>{GROUP_LABELS.recent.subtitle}</span>
                    </header>
                    {visible.recent.map(renderCard)}
                  </section>
                )}

                {showGroup("configured") && visible.configured.length > 0 && (
                  <section className={s.mpGroup}>
                    <header className={s.mpGroupHeader}>
                      <span>{GROUP_LABELS.configured.name}</span>
                      <span className={s.mpGroupSub}>{GROUP_LABELS.configured.subtitle}</span>
                    </header>
                    {visible.configured.map(renderCard)}
                  </section>
                )}

                {showGroup("recommended") && visible.recommended.length > 0 && (
                  <section className={s.mpGroup}>
                    <header className={s.mpGroupHeader}>
                      <span>{GROUP_LABELS.recommended.name}</span>
                      <span className={s.mpGroupSub}>{GROUP_LABELS.recommended.subtitle}</span>
                    </header>
                    {visible.recommended.map(renderCard)}
                  </section>
                )}

                {showGroup("more") && visible.more.length > 0 && (
                  <section className={s.mpGroup}>
                    <button
                      type="button"
                      className={s.mpGroupCollapsible}
                      onClick={() => setMoreExpanded((x) => !x)}
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className={s.mpGroupChevron}
                        data-expanded={moreExpanded ? "true" : undefined}
                      />
                      <span>{GROUP_LABELS.more.name} · {visible.more.length} 项</span>
                      <span className={s.mpGroupSub}>{GROUP_LABELS.more.subtitle}</span>
                    </button>
                    {moreExpanded && visible.more.map(renderCard)}
                  </section>
                )}
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
          <h2 id={titleId}>选择模型</h2>
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
