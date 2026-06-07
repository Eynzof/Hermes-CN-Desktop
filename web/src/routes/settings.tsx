import { useState, useMemo, useEffect, useRef, useCallback, type CSSProperties } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  Bug,
  CheckCircle2,
  Copy,
  ExternalLink as ExternalLinkIcon,
  FolderOpen,
  GitCommit,
  GitFork,
  Globe2,
  Heart,
  Info,
  MessageCircle,
  RefreshCw,
  Download,
  RotateCcw,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { Dialog, useTheme, type ThemeConfig } from "@hermes/shared-ui";
import { useConfig, useConfigSchema, useSaveConfig } from "@/hooks/use-config";
import { useSkills, useToggleSkill } from "@/hooks/use-skills";
import { cronJobProfile, useCronJobs, useCreateCronJob, useDeleteCronJob, useCronAction } from "@/hooks/use-cron";
import { useLogs } from "@/hooks/use-logs";
import { useStatus } from "@/hooks/use-status";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { useYoloMode, useSetYoloMode, isYoloModeSupported } from "@/hooks/use-yolo-mode";
import { useGatewayRestartAction } from "@/hooks/use-gateway-restart";
import {
  useCheckRuntimeUpdate,
  useInstallRuntimeUpdate,
  useRollbackRuntime,
  useRuntimeInfo,
} from "@/hooks/use-runtime-update";
import {
  CONVERSATION_FONT_SIZE_OPTIONS,
  composerSubmitShortcutAtom,
  conversationFontSizeAtom,
  profileSwitchingAtom,
  showReasoningAtom,
  type ConversationFontSizeMode,
} from "@/stores/ui";
import { openExternalUrl } from "@/lib/external-links";
import { checkDesktopUpdate, DESKTOP_UPDATE_DOWNLOAD_URL } from "@/lib/desktop-update";
import { DESKTOP_VERSION, versionLabel } from "@/lib/build-info";
import {
  approvalModeConfigValue,
  approvalModeLabel,
  isApprovalModeAvailable,
  normalizeApprovalMode,
  type ApprovalMode,
} from "@/lib/approval-mode";
import { buildNestedConfigUpdate, mergeConfigUpdate } from "@/lib/config-update";
import { translateConfigField, translateConfigOption } from "@/lib/config-translations";
import { gatewayRestartButtonLabel, gatewayRestartTitle } from "@/lib/gateway-restart";
import type { ComposerSubmitShortcut } from "@/lib/composer-submit-shortcut";
import type { ConfigSchemaField, CronJob, DesktopUpdateCheckResult, RuntimeInfo, RuntimeUpdateCheckResult } from "@hermes/protocol";
import { CopyButton } from "@/components/ui/copy-button";
import wechatCommunityQr from "@/assets/wechat-community-qr.png";
import s from "./settings.module.css";

/* ── General ─────────────────────────────────────────────────────────── */

interface SettingsSectionProps {
  showHeading?: boolean;
}

export function GeneralSection({ showHeading = true }: SettingsSectionProps) {
  const [showReasoning, setShowReasoning] = useAtom(showReasoningAtom);
  const [composerSubmitShortcut, setComposerSubmitShortcut] = useAtom(composerSubmitShortcutAtom);

  return (
    <div>
      {showHeading && <h2 className={s.heading}>常规</h2>}
      <Row label="显示推理过程" sub="在会话中展示模型的思考和推理内容" right={
        <RadioGroup value={showReasoning ? "on" : "off"} options={[{ value: "off", label: "隐藏" }, { value: "on", label: "显示" }]} onChange={(v) => setShowReasoning(v === "on")} />
      } />
      <Row label="发送快捷键" sub="控制对话输入框的提交方式；未触发发送的 Enter 会保留为换行。" right={
        <RadioGroup value={composerSubmitShortcut} options={[{ value: "enter", label: "Enter 发送" }, { value: "ctrl-enter", label: "Ctrl+Enter 发送" }]} onChange={(v) => setComposerSubmitShortcut(v as ComposerSubmitShortcut)} />
      } />
      <ApprovalModeSection />
    </div>
  );
}

export function ThemeSection({ showHeading = true }: SettingsSectionProps) {
  const { config, update } = useTheme();
  const [conversationFontSize, setConversationFontSize] = useAtom(conversationFontSizeAtom);

  return (
    <div>
      {showHeading && <h2 className={s.heading}>主题</h2>}
      <div className={s.appearancePanel}>
        <div className={s.appearanceHeader}>
          <div className={s.appearanceHeaderText}>
            <h3>外观</h3>
            <p>颜色、密度和对话阅读字号会立即应用到桌面端界面。</p>
          </div>
          <span className={s.appearanceMeta}>颜色 · 密度 · 字号</span>
        </div>

        <AppearanceRow
          label="主题"
          sub="选择桌面端皮肤。现代主题采用更克制的工作台配色和蓝色主操作。"
          right={
            <ThemeSkinPicker
              value={config.theme}
              onChange={(theme) => update({ theme })}
            />
          }
        />
        <AppearanceRow
          label="密度"
          sub="调整行与卡片的垂直留白。舒适匹配当前默认布局。"
          right={
            <RadioGroup value={config.density} options={[{ value: "compact", label: "紧凑" }, { value: "comfortable", label: "舒适" }]} onChange={(v) => update({ density: v as ThemeConfig["density"] })} />
          }
        />
        <AppearanceRow
          label="对话字号"
          sub="只影响会话详情里的对话正文；代码块、工具日志和输入框保持原字号。"
          right={
            <RadioGroup
              value={conversationFontSize}
              options={CONVERSATION_FONT_SIZE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(v) => setConversationFontSize(v as ConversationFontSizeMode)}
            />
          }
        />
      </div>
    </div>
  );
}

const THEME_SKINS: Array<{
  value: ThemeConfig["theme"];
  label: string;
  sub: string;
  bg: string;
  pane: string;
  soft: string;
  text: string;
  accent: string;
}> = [
  {
    value: "light",
    label: "浅色",
    sub: "明亮柔和",
    bg: "#fbfaf7",
    pane: "#ffffff",
    soft: "#f5f2ec",
    text: "#232120",
    accent: "#ff7a3d",
  },
  {
    value: "light-modern",
    label: "现代浅色",
    sub: "白色工作台",
    bg: "#f3f3f3",
    pane: "#ffffff",
    soft: "#f0f0f0",
    text: "#1f1f1f",
    accent: "#0078d4",
  },
  {
    value: "dark",
    label: "经典深色",
    sub: "暖墨颗粒",
    bg: "#0a0908",
    pane: "#11100e",
    soft: "#232120",
    text: "#faf7f0",
    accent: "#ff7a3d",
  },
  {
    value: "dark-modern",
    label: "现代深色",
    sub: "蓝黑工作台",
    bg: "#181818",
    pane: "#1f1f1f",
    soft: "#252526",
    text: "#d4d4d4",
    accent: "#0078d4",
  },
];

function AppearanceRow({
  label,
  sub,
  right,
  meta,
}: {
  label: string;
  sub: string;
  right: React.ReactNode;
  meta?: string;
}) {
  return (
    <div className={s.appearanceRow}>
      <div className={s.appearanceRowText}>
        <div className={s.appearanceRowLabel}>{label}</div>
        <div className={s.appearanceRowSub}>{sub}</div>
      </div>
      <div className={s.appearanceRowControl}>{right}</div>
      {meta ? <div className={s.appearanceRowMeta}>{meta}</div> : null}
    </div>
  );
}

function ThemeSkinPicker({
  value,
  onChange,
}: {
  value: ThemeConfig["theme"];
  onChange: (theme: ThemeConfig["theme"]) => void;
}) {
  return (
    <div className={s.skinPicker} role="radiogroup" aria-label="主题皮肤">
      {THEME_SKINS.map((skin) => {
        const active = skin.value === value;
        const style = {
          "--skin-bg": skin.bg,
          "--skin-pane": skin.pane,
          "--skin-soft": skin.soft,
          "--skin-text": skin.text,
          "--skin-accent": skin.accent,
        } as CSSProperties;
        return (
          <button
            key={skin.value}
            type="button"
            className={s.skinCard}
            style={style}
            role="radio"
            aria-checked={active}
            data-active={active ? "true" : undefined}
            onClick={() => onChange(skin.value)}
          >
            <span className={s.skinPreview} aria-hidden="true">
              <span className={s.skinPreviewTop} />
              <span className={s.skinPreviewBody}>
                <span />
                <span />
                <span />
              </span>
              <span className={s.skinPreviewAccent} />
            </span>
            <span className={s.skinCopy}>
              <span className={s.skinTitle}>{skin.label}</span>
              <span className={s.skinSub}>{skin.sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Approval mode ───────────────────────────────────────────────────── */

const APPROVAL_MODE_DESC: Record<ApprovalMode, string> = {
  default: "匹配危险模式的命令会要求你手动确认，适合大多数工作区的默认安全策略。",
  smart: "使用智能审批辅助模型先判断风险，低风险自动放行，高风险自动拒绝，不确定时再提示你手动决定。",
  yolo: "自动批准所有危险命令（等同后端 --yolo / HERMES_YOLO_MODE）。请仅在受信任或隔离的工作区使用。",
};

function ApprovalModeSection() {
  const navigate = useNavigate();
  const { data: config } = useConfig();
  const { data: schema } = useConfigSchema();
  const saveConfig = useSaveConfig();
  const { data: yolo } = useYoloMode();
  const setYolo = useSetYoloMode();
  const restartInFlight = useAtomValue(profileSwitchingAtom).active;
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pendingMode, setPendingMode] = useState<ApprovalMode | null>(null);
  const [error, setError] = useState("");

  const approvalOptions = schema?.fields["approvals.mode"]?.options ?? [];
  const rawConfigMode = getNestedValue(config, "approvals.mode");
  const yoloEnabled = !!yolo?.enabled;
  const yoloEffective = !!yolo?.effective;
  const currentMode: ApprovalMode = yoloEnabled || yoloEffective ? "yolo" : normalizeApprovalMode(rawConfigMode);
  const yoloPending = yolo != null && yolo.enabled !== yolo.effective;
  const busy = saveConfig.isPending || setYolo.isPending || restartInFlight || pendingMode !== null;
  const smartAvailable = isApprovalModeAvailable("smart", approvalOptions, schema?.fields);
  const yoloAvailable = isYoloModeSupported() || isApprovalModeAvailable("yolo", approvalOptions);

  useEffect(() => {
    const focusFromHash = () => {
      if (window.location.hash !== "#approval-mode") return;
      window.requestAnimationFrame(() => {
        const el = sectionRef.current;
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus({ preventScroll: true });
      });
    };
    focusFromHash();
    window.addEventListener("hashchange", focusFromHash);
    return () => window.removeEventListener("hashchange", focusFromHash);
  }, []);

  const saveApprovalMode = async (mode: ApprovalMode) => {
    if (!config) throw new Error("配置尚未加载完成，请稍后再试");
    const nextValue = approvalModeConfigValue(mode, approvalOptions);
    const nextConfig = mergeConfigUpdate(config, buildNestedConfigUpdate("approvals.mode", nextValue));
    await saveConfig.mutateAsync(nextConfig);
  };

  const applyMode = async (mode: ApprovalMode) => {
    if (busy) return;
    if (mode === "smart" && !smartAvailable) {
      setError("当前 runtime 的配置 schema 尚未声明 smart 审批模式，请先更新 Hermes Agent runtime。");
      return;
    }
    if (mode === "yolo") {
      if (!yoloAvailable) {
        setError("当前环境不支持 YOLO 模式。");
        return;
      }
      setAcknowledged(false);
      setConfirmOpen(true);
      return;
    }

    setPendingMode(mode);
    setError("");
    try {
      await saveApprovalMode(mode);
      if ((yoloEnabled || yoloEffective) && isYoloModeSupported()) {
        await setYolo.mutateAsync(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err || "审批模式保存失败"));
    } finally {
      setPendingMode(null);
    }
  };

  const confirmEnableYolo = async () => {
    if (busy || !acknowledged) return;
    setConfirmOpen(false);
    setPendingMode("yolo");
    setError("");
    try {
      await saveApprovalMode("yolo");
      if (isYoloModeSupported()) {
        await setYolo.mutateAsync(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err || "YOLO 模式开启失败"));
    } finally {
      setPendingMode(null);
    }
  };

  const openSmartModelConfig = () => {
    navigate("/models#auxiliary-approval");
  };

  return (
    <section
      id="approval-mode"
      ref={sectionRef}
      className={s.approvalModePanel}
      tabIndex={-1}
      aria-labelledby="approval-mode-title"
    >
      <div className={s.approvalModeHead}>
        <ShieldCheck size={14} aria-hidden="true" />
        <div>
          <h3 id="approval-mode-title">危险命令审批模式</h3>
          <p>统一管理危险 shell 命令的确认策略。新设置只影响后续命令，已经弹出的审批请求仍需单独处理。</p>
        </div>
      </div>

      <div className={s.approvalModeOptions} role="radiogroup" aria-label="危险命令审批模式">
        {(["default", "smart", "yolo"] as const).map((mode) => {
          const isCurrent = currentMode === mode;
          const isSaving = pendingMode === mode || (mode === "yolo" && setYolo.isPending);
          const disabled = busy ||
            (mode === "smart" && !smartAvailable) ||
            (mode === "yolo" && !yoloAvailable);
          return (
            <button
              key={mode}
              type="button"
              className={s.approvalModeOption}
              data-active={isCurrent ? "true" : undefined}
              data-danger={mode === "yolo" ? "true" : undefined}
              role="radio"
              aria-checked={isCurrent}
              disabled={disabled}
              onClick={() => void applyMode(mode)}
            >
              <span className={s.approvalModeOptionTitle}>
                {approvalModeLabel(mode)}
                {isCurrent && <span className={s.approvalModeBadge}>当前</span>}
                {isSaving && <span className={s.approvalModeBadge}>保存中…</span>}
              </span>
              <span className={s.approvalModeOptionDesc}>{APPROVAL_MODE_DESC[mode]}</span>
              {mode === "smart" && !smartAvailable && (
                <span className={s.approvalModeWarning}>当前 runtime 暂未声明 smart 选项，请先更新 runtime。</span>
              )}
              {mode === "yolo" && yoloPending && (
                <span className={s.approvalModeWarning}>YOLO 启动开关已保存，重启桌面端后生效。</span>
              )}
            </button>
          );
        })}
      </div>

      <div className={s.approvalModeFooter}>
        <button type="button" className={s.btn} onClick={openSmartModelConfig}>
          配置智能审批辅助模型
        </button>
        <span>
          Smart 模式会使用 <code>auxiliary.approval</code> 槽位。未指定时由后端自动选择可用辅助模型。
        </span>
      </div>

      {error && <div className={s.approvalModeError}>保存失败：{error}</div>}

      <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content className={s.dangerDialog} aria-describedby="yolo-confirm-desc">
            <Dialog.Title className={s.dangerDialogTitle}>
              <AlertTriangle size={16} aria-hidden="true" />
              确认开启 YOLO 模式？
            </Dialog.Title>
            <Dialog.Description id="yolo-confirm-desc" className={s.dangerDialogBody}>
              开启后，Agent 执行 shell 命令、删除文件等高危操作时将<strong>不再弹出二次确认</strong>，
              全部自动批准。请确认你信任当前工作区、并清楚 Agent 将要做什么。切换会重启内核（约 5-15 秒）。
            </Dialog.Description>
            <label className={s.dangerConfirmRow}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              我已了解风险
            </label>
            <div className={s.dangerDialogActions}>
              <Dialog.Close asChild>
                <button className={s.btn}>取消</button>
              </Dialog.Close>
              <button className={s.btnDanger} disabled={!acknowledged || busy} onClick={() => void confirmEnableYolo()}>
                确认开启
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}


/* ── Config (Full Config Editor — maps to /api/config) ──────────────── */

const CATEGORY_CN: Record<string, string> = {
  general: "常规", agent: "Agent", terminal: "终端", display: "显示",
  delegation: "委派", memory: "记忆", compression: "压缩", security: "安全",
  browser: "浏览器", voice: "语音", tts: "TTS", stt: "STT",
  logging: "日志记录", discord: "Discord", auxiliary: "辅助",
};

export function ConfigSection({ showHeading = true }: SettingsSectionProps) {
  const { data: config } = useConfig();
  const { data: schema } = useConfigSchema();
  const saveConfig = useSaveConfig();
  const [activeCategory, setActiveCategory] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const categories = useMemo(() => {
    if (!schema) return [];
    return schema.category_order.length > 0
      ? schema.category_order
      : [...new Set(Object.values(schema.fields).map((f) => f.category))];
  }, [schema]);

  const categoryCounts = useMemo(() => {
    if (!schema) return {} as Record<string, number>;
    const counts: Record<string, number> = {};
    for (const f of Object.values(schema.fields)) {
      counts[f.category] = (counts[f.category] || 0) + 1;
    }
    return counts;
  }, [schema]);

  useEffect(() => {
    if (categories.length > 0 && !activeCategory) setActiveCategory(categories[0]);
  }, [categories, activeCategory]);

  if (!config || !schema) return <div className={s.desc}>加载中…</div>;

  const isSearching = searchQuery.trim().length > 0;
  const lowerSearch = searchQuery.toLowerCase();

  const displayFields = isSearching
    ? Object.entries(schema.fields).filter(([key, f]) => {
        const label = key.split(".").pop()?.replace(/_/g, " ") ?? key;
        return key.toLowerCase().includes(lowerSearch)
          || label.toLowerCase().includes(lowerSearch)
          || f.description.toLowerCase().includes(lowerSearch)
          || translateConfigField(key, f.description).toLowerCase().includes(lowerSearch)
          || (CATEGORY_CN[f.category] ?? f.category).toLowerCase().includes(lowerSearch);
      })
    : Object.entries(schema.fields).filter(([, f]) => f.category === activeCategory);

  return (
    <div>
      {showHeading && <h2 className={s.heading}>配置</h2>}
      <p className={s.desc}>
        Hermes Agent 全部 {Object.keys(schema.fields).length} 个配置项，
        共 {categories.length} 个分类。修改后点击字段旁的"保存"按钮生效。
      </p>

      <div style={{ marginBottom: 12 }}>
        <input className={s.fieldInput} placeholder="搜索配置项…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
      </div>

      {!isSearching && (
        <div className={s.configTabs} role="tablist" aria-label="配置分类">
          {categories.map((cat) => (
            <button
              key={cat}
              className={s.configTab}
              data-active={cat === activeCategory}
              role="tab"
              aria-selected={cat === activeCategory}
              onClick={() => setActiveCategory(cat)}
            >
              {CATEGORY_CN[cat] ?? cat}
              <span className={s.configTabCount}>{categoryCounts[cat] || 0}</span>
            </button>
          ))}
        </div>
      )}

      {isSearching && (
        <div className={s.modelsLabel}>搜索结果: {displayFields.length} 项</div>
      )}

      <div style={{ marginTop: 8 }}>
        {displayFields.map(([key, field]) => (
          <ConfigFieldRow
            key={key}
            fieldKey={key}
            field={field}
            value={getNestedValue(config, key)}
            onSave={(val) => saveConfig.mutate(mergeConfigUpdate(config, buildNestedConfigUpdate(key, val)))}
            showCategory={isSearching}
          />
        ))}
        {displayFields.length === 0 && (
          <div className={s.desc}>{isSearching ? `未找到匹配 "${searchQuery}" 的配置项。` : "此分类下暂无配置项。"}</div>
        )}
      </div>
    </div>
  );
}

/* ── Skills ───────────────────────────────────────────────────────────── */

export function SkillsSection() {
  const { data: skills, isLoading, isFetching, isError, error, refetch } = useSkills();
  const toggleSkill = useToggleSkill();
  const [filter, setFilter] = useState("");
  const refreshButton = (
    <button className={s.btn} type="button" onClick={() => void refetch()} disabled={isFetching}>
      <RefreshCw size={13} />
      {isFetching ? "刷新中" : "刷新"}
    </button>
  );

  if (isLoading) return <div className={s.desc}>加载中…</div>;
  if (isError) {
    const message = error instanceof Error ? error.message : "unknown error";
    return (
      <div>
        <div className={s.sectionTitleRow}>{refreshButton}</div>
        <p className={s.desc}>技能加载失败：{message}</p>
      </div>
    );
  }
  if (!skills) return null;

  const filtered = filter
    ? skills.filter((sk) => sk.name.includes(filter) || sk.description.includes(filter) || (sk.category ?? "").includes(filter))
    : skills;

  const grouped = groupBy(filtered, (sk) => sk.category ?? "other");

  return (
    <div>
      <div className={s.sectionTitleRow}>{refreshButton}</div>
      <p className={s.desc}>{skills.length} 个可用技能。启用/禁用后立即生效。</p>
      <div style={{ marginBottom: 16 }}>
        <input className={s.fieldInput} placeholder="搜索技能…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {skills.length === 0 && <div className={s.desc}>未发现已安装技能。后端当前返回 0 项，请检查 Hermes home 的 skills 同步。</div>}
      {skills.length > 0 && filtered.length === 0 && <div className={s.desc}>没有匹配的技能。</div>}
      {Object.entries(grouped).map(([category, items]) => (
        <div key={category} style={{ marginBottom: 16 }}>
          <div className={s.modelsLabel}>{category} ({items.length})</div>
          {items.map((sk) => (
            <div key={sk.name} className={s.row}>
              <div className={s.rowLeft}>
                <div className={s.rowLabel}>{sk.name}</div>
                <div className={s.rowSub}>{sk.description}</div>
              </div>
              <div className={s.rowRight}>
                <button className={s.toggle} data-on={sk.enabled} onClick={() => toggleSkill.mutate({ name: sk.name, enabled: !sk.enabled })}>
                  <span className={s.toggleThumb} />
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── Cron Jobs ───────────────────────────────────────────────────────── */

function cronText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cronScheduleDisplay(job: CronJob): string {
  const schedule = job.schedule;
  if (cronText(job.schedule_display)) return cronText(job.schedule_display);
  if (typeof schedule === "string") return cronText(schedule) || "未设置";
  if (schedule && typeof schedule === "object") {
    return cronText(schedule.display) || cronText(schedule.expr) || cronText(schedule.value) || "未设置";
  }
  return "未设置";
}

function cronTitle(job: CronJob): string {
  return cronText(job.name) || cronText(job.prompt).slice(0, 60) || cronText(job.script).slice(0, 60) || job.id;
}

function cronPromptPreview(job: CronJob): string {
  return cronText(job.prompt) || (cronText(job.script) ? `脚本：${cronText(job.script)}` : "无任务描述");
}

function cronState(job: CronJob): string {
  return cronText(job.state) || (job.enabled ? "scheduled" : "paused");
}

function cronStateLabel(job: CronJob): string {
  const state = cronState(job);
  if (state === "scheduled") return "计划中";
  if (state === "paused") return "暂停";
  if (state === "running") return "执行中";
  if (state === "completed") return "已完成";
  if (state === "error") return "错误";
  return job.enabled ? "启用" : "暂停";
}

function cronResultLine(job: CronJob): string | null {
  const status = cronText(job.last_status);
  if (!status) return null;
  if (status === "ok") return "上次结果：成功";
  if (status === "error") return `上次结果：失败${cronText(job.last_error) ? ` · ${cronText(job.last_error)}` : ""}`;
  return `上次结果：${status}`;
}

function cronIsPaused(job: CronJob): boolean {
  return !job.enabled || cronState(job) === "paused";
}

function formatCronTime(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const date = typeof value === "number"
    ? new Date(value < 1_000_000_000_000 ? value * 1000 : value)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function cronActionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "请求失败");
}

type CronFeedback = {
  tone: "ok" | "info" | "error";
  message: string;
};

export function CronSection() {
  const { data: jobs, isLoading, isError, error, refetch } = useCronJobs();
  const activeProfile = useActiveProfileName();
  const createJob = useCreateCronJob();
  const deleteJob = useDeleteCronJob();
  const cronAction = useCronAction();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSchedule, setNewSchedule] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [feedback, setFeedback] = useState<CronFeedback | null>(null);
  const refreshTimersRef = useRef<number[]>([]);

  const clearQueuedRefreshes = useCallback(() => {
    refreshTimersRef.current.forEach((id) => window.clearTimeout(id));
    refreshTimersRef.current = [];
  }, []);

  const queueFollowUpRefreshes = useCallback(() => {
    clearQueuedRefreshes();
    refreshTimersRef.current = [2_000, 8_000, 30_000, 65_000].map((delay) =>
      window.setTimeout(() => void refetch(), delay),
    );
  }, [clearQueuedRefreshes, refetch]);

  useEffect(() => clearQueuedRefreshes, [clearQueuedRefreshes]);

  const handleCreate = () => {
    if (!newSchedule || !newPrompt) return;
    createJob.mutate(
      { name: newName || undefined, schedule: newSchedule, prompt: newPrompt, profile: activeProfile || "default" },
      {
        onSuccess: (job) => {
          setShowNew(false);
          setNewName("");
          setNewSchedule("");
          setNewPrompt("");
          setFeedback({ tone: "ok", message: `已创建定时任务「${cronTitle(job)}」。` });
        },
        onError: (err) => setFeedback({ tone: "error", message: `创建定时任务失败：${cronActionError(err)}` }),
      },
    );
  };

  const handleCronAction = (job: CronJob, action: "pause" | "resume" | "trigger") => {
    cronAction.mutate(
      { id: job.id, profile: cronJobProfile(job), action },
      {
        onSuccess: (updated) => {
          if (action === "trigger") {
            setFeedback({
              tone: "info",
              message: `已触发「${cronTitle(updated)}」，内核会在下一次调度 tick 执行，通常 60 秒内会刷新运行结果。`,
            });
            queueFollowUpRefreshes();
            return;
          }
          setFeedback({
            tone: "ok",
            message: `${action === "pause" ? "已暂停" : "已恢复"}「${cronTitle(updated)}」。`,
          });
        },
        onError: (err) => {
          const actionLabel = action === "pause" ? "暂停" : action === "resume" ? "恢复" : "触发";
          setFeedback({ tone: "error", message: `${actionLabel}定时任务失败：${cronActionError(err)}` });
        },
      },
    );
  };

  const handleDelete = (job: CronJob) => {
    deleteJob.mutate({ id: job.id, profile: cronJobProfile(job) }, {
      onSuccess: () => setFeedback({ tone: "ok", message: `已删除定时任务「${cronTitle(job)}」。` }),
      onError: (err) => setFeedback({ tone: "error", message: `删除定时任务失败：${cronActionError(err)}` }),
    });
  };

  return (
    <div>
      <p className={s.desc}>Agent 会按计划自动执行这些任务。</p>
      {feedback && (
        <div className={s.cronFeedback} data-tone={feedback.tone} role={feedback.tone === "error" ? "alert" : "status"}>
          {feedback.message}
        </div>
      )}
      {isLoading && <div className={s.desc}>加载中…</div>}
      {isError && (
        <div className={s.providerDetail} style={{ marginTop: 12 }}>
          <div className={s.desc}>加载定时任务失败：{error instanceof Error ? error.message : String(error)}</div>
          <button className={s.btn} onClick={() => void refetch()}>重试</button>
        </div>
      )}
      {!isLoading && !isError && jobs && jobs.length === 0 && !showNew && <div className={s.desc}>暂无定时任务。</div>}
      {!isError && jobs?.map((job) => {
        const paused = cronIsPaused(job);
        return (
          <div key={`${job.profile ?? "default"}:${job.id}`} className={s.row}>
            <div className={s.rowLeft}>
              <div className={s.rowLabel}>{cronTitle(job)}</div>
              <div className={s.rowSub}>{cronScheduleDisplay(job)} · {cronPromptPreview(job).slice(0, 60)}</div>
              <div className={s.rowSub}>下次：{formatCronTime(job.next_run_at ?? job.next_run)} · 上次：{formatCronTime(job.last_run_at ?? job.last_run)}</div>
              {cronResultLine(job) && <div className={s.rowSub}>{cronResultLine(job)}</div>}
            </div>
            <div className={s.rowRight} style={{ gap: 6 }}>
              <span className={s.statusBadge} data-on={!paused}>{cronStateLabel(job)}</span>
              <button className={s.btn} disabled={cronAction.isPending || deleteJob.isPending} onClick={() => handleCronAction(job, paused ? "resume" : "pause")}>
                {paused ? "恢复" : "暂停"}
              </button>
              <button className={s.btn} disabled={cronAction.isPending || deleteJob.isPending} onClick={() => handleCronAction(job, "trigger")}>触发</button>
              <button className={s.btnDanger} disabled={cronAction.isPending || deleteJob.isPending} onClick={() => handleDelete(job)}>删除</button>
            </div>
          </div>
        );
      })}
      {showNew ? (
        <div className={s.providerDetail} style={{ marginTop: 12 }}>
          <FieldRow label="名称（可选）" value={newName} onChange={setNewName} />
          <FieldRow label="Cron 表达式" value={newSchedule} onChange={setNewSchedule} placeholder="0 9 * * *" />
          <FieldRow label="Prompt" value={newPrompt} onChange={setNewPrompt} placeholder="每天执行的任务描述…" />
          <div className={s.providerActions}>
            <button className={s.btnPrimary} onClick={handleCreate} disabled={createJob.isPending}>创建</button>
            <button className={s.btn} onClick={() => setShowNew(false)} disabled={createJob.isPending}>取消</button>
          </div>
        </div>
      ) : (
        <button className={s.btnPrimary} style={{ marginTop: 12 }} onClick={() => setShowNew(true)}>＋ 新建定时任务</button>
      )}
    </div>
  );
}

/* ── Logs ─────────────────────────────────────────────────────────────── */

const LOG_FILES = ["agent", "errors", "gateway"] as const;
const LOG_LEVELS = ["ALL", "DEBUG", "INFO", "WARNING", "ERROR"] as const;
const LOG_COMPONENTS = ["all", "gateway", "agent", "tools", "cli", "cron"] as const;
const LOG_LINE_COUNTS = [50, 100, 200, 500] as const;

function classifyLine(line: string): "error" | "warning" | "debug" | "info" {
  const upper = line.toUpperCase();
  if (upper.includes("ERROR") || upper.includes("CRITICAL") || upper.includes("FATAL")) return "error";
  if (upper.includes("WARNING") || upper.includes("WARN")) return "warning";
  if (upper.includes("DEBUG")) return "debug";
  return "info";
}

export function LogsSection() {
  const [file, setFile] = useState<string>("agent");
  const [level, setLevel] = useState<string>("ALL");
  const [component, setComponent] = useState<string>("all");
  const [lineCount, setLineCount] = useState<number>(100);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, refetch } = useLogs(file, lineCount, level, component);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => refetch(), 5000);
    return () => clearInterval(id);
  }, [autoRefresh, refetch]);

  useEffect(() => {
    if (data && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data]);

  return (
    <div>
      <div className={s.filterBar}>
        <FilterGroup label="文件">
          {LOG_FILES.map((f) => (
            <button key={f} className={s.segmentBtn} data-active={f === file} onClick={() => setFile(f)}>{f}</button>
          ))}
        </FilterGroup>
        <FilterGroup label="级别">
          {LOG_LEVELS.map((l) => (
            <button key={l} className={s.segmentBtn} data-active={l === level} onClick={() => setLevel(l)}>{l}</button>
          ))}
        </FilterGroup>
        <FilterGroup label="组件">
          {LOG_COMPONENTS.map((c) => (
            <button key={c} className={s.segmentBtn} data-active={c === component} onClick={() => setComponent(c)}>{c}</button>
          ))}
        </FilterGroup>
        <FilterGroup label="行数">
          {LOG_LINE_COUNTS.map((n) => (
            <button key={n} className={s.segmentBtn} data-active={n === lineCount} onClick={() => setLineCount(n)}>{n}</button>
          ))}
        </FilterGroup>
      </div>

      <div className={s.logToolbar}>
        <label className={s.autoRefreshLabel}>
          <button className={s.toggle} data-on={autoRefresh} onClick={() => setAutoRefresh(!autoRefresh)}>
            <span className={s.toggleThumb} />
          </button>
          <span>自动刷新</span>
          {autoRefresh && <span className={s.liveDot} />}
        </label>
        <button className={s.btn} onClick={() => refetch()} disabled={isLoading}>
          {isLoading ? "加载中…" : "刷新"}
        </button>
      </div>

      <div className={s.logBlock} ref={scrollRef} style={{ maxHeight: "calc(100vh - 340px)", minHeight: 300 }}>
        {data?.lines.map((line, i) => {
          const cls = classifyLine(line);
          return <div key={i} className={`${s.logLine} ${s[`logLine_${cls}`] ?? ""}`}>{line}</div>;
        })}
        {data && data.lines.length === 0 && <div className={s.logLine}>（无日志）</div>}
        {!data && isLoading && <div className={s.logLine}>加载中…</div>}
      </div>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={s.filterGroup}>
      <span className={s.filterLabel}>{label}</span>
      <div className={s.segmented}>{children}</div>
    </div>
  );
}

/* ── Kernel ──────────────────────────────────────────────────────────── */

export function KernelSection({ showHeading = true }: SettingsSectionProps) {
  const statusQuery = useStatus();
  const status = statusQuery.data;
  const runtimeInfo = useRuntimeInfo();
  const checkRuntimeUpdate = useCheckRuntimeUpdate();
  const installRuntimeUpdate = useInstallRuntimeUpdate();
  const rollbackRuntime = useRollbackRuntime();
  const gatewayRestart = useGatewayRestartAction();
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [aboutMessage, setAboutMessage] = useState("");

  const handleCheckRuntime = async () => {
    setRuntimeMessage("");
    const result = await checkRuntimeUpdate.mutateAsync();
    setRuntimeMessage(formatRuntimeUpdateResult(result));
  };

  const handleInstallRuntime = async () => {
    setRuntimeMessage("");
    const result = await installRuntimeUpdate.mutateAsync();
    setRuntimeMessage(result.ok
      ? `已切换到 runtime ${result.installed?.runtimeVersion ?? ""}`.trim()
      : result.error ?? "runtime 更新失败");
  };

  const handleRollbackRuntime = async () => {
    setRuntimeMessage("");
    const result = await rollbackRuntime.mutateAsync();
    setRuntimeMessage(result.ok
      ? `已回滚到 runtime ${result.installed?.runtimeVersion ?? ""}`.trim()
      : result.error ?? "runtime 回滚失败");
  };

  const info = runtimeInfo.data;
  const process = info?.process;
  const source = info?.source;
  const rendererRuntime = typeof window !== "undefined" ? window.__HERMES_RUNTIME__ : undefined;
  const hermesHomePath = status?.hermes_home;
  const runtimeRootPath = info?.runtimeRoot;
  const runtimeVersionPath = info?.current?.path;
  const currentRecordPath = info?.currentRecordPath;
  const updateResult = checkRuntimeUpdate.data;
  const installing = installRuntimeUpdate.isPending;
  const checking = checkRuntimeUpdate.isPending;
  const rollingBack = rollbackRuntime.isPending;
  const hasRuntimeBridge = typeof window !== "undefined" && Boolean(window.hermesDesktop?.getRuntimeInfo);
  const canInstall = Boolean(updateResult?.ok && updateResult.updateAvailable && info?.updatesConfigured);
  const refreshing = runtimeInfo.isFetching || statusQuery.isFetching;
  const runtimeInsideRoot = Boolean(
    info?.current?.executablePath &&
    info.runtimeRoot &&
    info.current.executablePath.startsWith(info.runtimeRoot),
  );
  const isolationOk = Boolean(
    info?.mode === "managed" &&
    runtimeInsideRoot &&
    process,
  );
  const diagnostics = useMemo(() => ({
    generatedAt: new Date().toISOString(),
    runtime: info ?? null,
    status: status ?? null,
    rendererRuntime: rendererRuntime ?? null,
    bridge: typeof window !== "undefined" ? {
      windowType: window.hermesDesktop?.windowType ?? null,
      hasRuntimeInfo: Boolean(window.hermesDesktop?.getRuntimeInfo),
      hasOpenWorkspacePath: Boolean(window.hermesDesktop?.openWorkspacePath),
    } : null,
  }), [info, rendererRuntime, status]);

  const handleRefreshAll = async () => {
    setAboutMessage("");
    await Promise.all([runtimeInfo.refetch(), statusQuery.refetch()]);
  };

  const handleOpenPath = async (path: string | undefined, label: string, setMessage = setRuntimeMessage) => {
    if (!path || !window.hermesDesktop?.openWorkspacePath) return;
    setRuntimeMessage("");
    setAboutMessage("");
    const result = await window.hermesDesktop.openWorkspacePath({ path });
    if (!result.ok) {
      setMessage(result.body || `打开${label}失败`);
    }
  };

  return (
    <div>
      {showHeading && <h2 className={s.heading}>内核</h2>}
      <div className={s.aboutHero} data-ok={isolationOk}>
        <div className={s.aboutHeroMark}>{isolationOk ? <ShieldCheck size={24} /> : <Bug size={24} />}</div>
        <div className={s.aboutHeroBody}>
          <div className={s.aboutEyebrow}>Hermes Agent 中文社区桌面版内核</div>
          <h3>{isolationOk ? (process?.ownsProcess ? "独立 runtime 内核正在运行" : "已连接到 managed runtime dashboard") : "正在读取内核隔离状态"}</h3>
          <p>
            {isolationOk && process?.ownsProcess
              ? "当前 Dashboard 由桌面端托管的 managed runtime 子进程提供，内核、gateway runtime 与锁文件都收束在桌面 runtime 目录下。"
              : isolationOk
                ? "当前固定端口上已有兼容 Dashboard，桌面端已连接它；runtime 指针和可执行路径仍位于桌面 managed runtime 目录内。"
              : "此处用于确认桌面端是否真的使用独立 hermes-agent-cn runtime，而不是复用全局 PATH 或外部 dashboard。"}
          </p>
        </div>
        <span className={s.statusBadge} data-on={isolationOk}>
          {info ? runtimeModeLabel(info.mode) : "读取中"}
        </span>
      </div>

      <div className={s.debugActionBar}>
        <button className={s.btn} type="button" onClick={handleRefreshAll} disabled={refreshing}>
          <RefreshCw size={13} />
          {refreshing ? "刷新中" : "刷新状态"}
        </button>
        <CopyButton className={s.btn} text={() => JSON.stringify(diagnostics, null, 2)}>
          <Copy size={13} />
          复制诊断 JSON
        </CopyButton>
        <button
          className={s.btn}
          type="button"
          onClick={() => handleOpenPath(hermesHomePath, " HERMES_HOME", setAboutMessage)}
          disabled={!hermesHomePath || !window.hermesDesktop?.openWorkspacePath}
        >
          <FolderOpen size={13} />
          打开 HERMES_HOME
        </button>
        <button
          className={s.btn}
          type="button"
          onClick={() => handleOpenPath(runtimeRootPath, " runtime 根目录")}
          disabled={!runtimeRootPath || !window.hermesDesktop?.openWorkspacePath}
        >
          <FolderOpen size={13} />
          打开 runtime
        </button>
        <button
          className={s.btnPrimary}
          onClick={() => void gatewayRestart.restart()}
          disabled={gatewayRestart.locked}
          title={gatewayRestartTitle(gatewayRestart.phase, gatewayRestart.message)}
          aria-busy={gatewayRestart.busy}
        >
          <RotateCcw size={13} />
          {gatewayRestart.phase === "idle" ? "重启 Gateway" : gatewayRestartButtonLabel(gatewayRestart.phase)}
        </button>
      </div>
      {aboutMessage && <div className={s.runtimeMessage} data-tone="error">{aboutMessage}</div>}
      {gatewayRestart.message && (
        <div className={s.runtimeMessage} data-tone={gatewayRestart.phase === "error" ? "error" : "normal"}>
          {gatewayRestart.message}
        </div>
      )}

      <div className={s.aboutDebugGrid}>
        <DebugCard icon={<Server size={15} />} title="内核进程" sub="Dashboard 子进程与连接状态" wide>
          <div className={s.runtimeGrid}>
            <RuntimeField label="托管方式" value={process ? (process.ownsProcess ? "桌面端独立子进程" : info?.mode === "managed" ? "连接到已存在 managed dashboard" : "复用外部进程") : "—"} />
            <RuntimeField label="PID" value={process?.pid ? String(process.pid) : "—"} mono />
            <RuntimeField label="API Origin" value={process?.apiBaseUrl ?? rendererRuntime?.apiBaseUrl ?? "Vite proxy / relative"} mono wide />
            <RuntimeField label="Gateway URL" value={process?.gatewayUrl ?? rendererRuntime?.gatewayUrl ?? "relative / SSE proxy"} mono wide />
            <RuntimeField label="档案" value={process?.currentProfile ?? rendererRuntime?.currentProfile ?? "—"} />
            <RuntimeField label="Session Token" value={process?.sessionTokenPresent ? "已注入" : "未注入 / dev proxy"} />
            <RuntimeField label="SSE 代理" value={process?.gatewaySseProxyActive ? "连接中" : "未连接或浏览器直连"} />
            <RuntimeField label="Ownership" value={process?.ownershipState ?? "—"} mono />
            <RuntimeField label="Ownership Marker" value={process?.ownershipMarkerPath ?? "—"} mono wide />
            <RuntimeField label="HERMES_HOME" value={process?.hermesHome || hermesHomePath || "—"} mono wide />
          </div>
          {process?.commandLine && (
            <div className={s.commandBlock}>
              <div className={s.commandBlockHeader}>
                <span><Terminal size={13} /> 启动命令</span>
                <CopyButton className={s.inlineCopyButton} text={process.commandLine}>复制</CopyButton>
              </div>
              <code>{process.commandLine}</code>
            </div>
          )}
        </DebugCard>

        <DebugCard icon={<ShieldCheck size={15} />} title="Managed Runtime" sub="当前内置 hermes-agent-cn 版本" wide>
          {hasRuntimeBridge ? (
            <>
              <div className={s.runtimeGrid}>
                <RuntimeField label="Runtime 完整版本" value={info?.current?.runtimeVersion ?? "未安装"} />
                <RuntimeField label="Hermes Agent 内核" value={info?.current?.kernelVersion ?? "—"} />
                <RuntimeField label="Runtime 修订" value={info?.current ? `${info.current.runtimeFlavor}.${info.current.runtimeRevision}` : "—"} />
                <RuntimeField label="来源" value={runtimeSourceLabel(info?.current?.source ?? info?.mode)} />
                <RuntimeField label="平台" value={info ? `${info.platform}-${info.arch}` : "…"} />
                <RuntimeField label="安装时间" value={formatDateTime(info?.current?.installedAt)} />
                <RuntimeField label="源码仓库" value={info?.current?.sourceRepo ?? source?.repo ?? "—"} mono wide />
                <RuntimeField label="已安装提交" value={shortCommit(info?.current?.sourceCommit)} mono />
                <RuntimeField label="源码 HEAD" value={shortCommit(source?.headCommit)} mono />
                <RuntimeField label="源码工作区" value={source?.dirty == null ? "未知" : source.dirty ? "有未提交改动" : "干净"} />
                <RuntimeField label="本地 dirty hash" value={info?.current?.localDirtyHash ?? "—"} mono />
                <RuntimeField label="可执行 SHA-256" value={shortHash(info?.executableSha256, 16)} mono />
              </div>
              {info?.lastError && <div className={s.runtimeMessage} data-tone="error">{info.lastError}</div>}
              {runtimeMessage && (
                <div className={s.runtimeMessage} data-tone={runtimeMessage.includes("失败") ? "error" : "normal"}>
                  {runtimeMessage}
                </div>
              )}
              <div className={s.providerActions}>
                <button
                  className={s.btn}
                  type="button"
                  onClick={() => handleOpenPath(runtimeVersionPath, " runtime 版本目录")}
                  disabled={!runtimeVersionPath || !window.hermesDesktop?.openWorkspacePath}
                >
                  <FolderOpen size={13} />
                  打开版本目录
                </button>
                <button
                  className={s.btn}
                  type="button"
                  onClick={() => handleOpenPath(currentRecordPath, " current.json")}
                  disabled={!currentRecordPath || !window.hermesDesktop?.openWorkspacePath}
                >
                  <FolderOpen size={13} />
                  打开 current.json
                </button>
                <button
                  className={s.btn}
                  type="button"
                  onClick={handleCheckRuntime}
                  disabled={!info?.updatesConfigured || checking}
                >
                  <RefreshCw size={13} />
                  {checking ? "检查中" : "检查更新"}
                </button>
                <button
                  className={s.btnPrimary}
                  type="button"
                  onClick={handleInstallRuntime}
                  disabled={!canInstall || installing}
                >
                  {installing ? "安装中…" : "安装更新"}
                </button>
                <button
                  className={s.btn}
                  type="button"
                  onClick={handleRollbackRuntime}
                  disabled={!info?.current?.previousRuntimeVersion || rollingBack}
                >
                  {rollingBack ? "回滚中…" : "回滚 Runtime"}
                </button>
              </div>
              {!info?.updatesConfigured && (
                <p className={s.desc}>
                  桌面端未配置 runtime 更新 manifest 或公钥；开发模式会优先使用本地安装脚本写入的 managed runtime。
                </p>
              )}
            </>
          ) : (
            <p className={s.desc}>当前环境没有桌面 runtime bridge，无法读取独立内核信息。</p>
          )}
        </DebugCard>

        <DebugCard icon={<Activity size={15} />} title="Dashboard / Gateway" sub="后端状态与网关运行态" wide>
          <div className={s.runtimeGrid}>
            <RuntimeField label="Hermes Agent" value={status ? `${status.version} (${status.release_date})` : "…"} />
            <RuntimeField label="活跃会话" value={String(status?.active_sessions ?? 0)} />
            <RuntimeField label="Gateway 状态" value={status?.gateway_state || (status?.gateway_running ? "running" : "unknown")} />
            <RuntimeField label="Gateway PID" value={status?.gateway_pid ? String(status.gateway_pid) : "—"} mono />
            <RuntimeField label="Gateway Health" value={status?.gateway_health_url ?? "—"} mono wide />
            <RuntimeField label="Gateway 更新时间" value={formatDateTime(status?.gateway_updated_at ?? undefined)} />
            <RuntimeField label="config.yaml" value={status?.config_path ?? "—"} mono wide />
            <RuntimeField label=".env" value={status?.env_path ?? "—"} mono wide />
          </div>
          {status?.gateway_platforms && Object.keys(status.gateway_platforms).length > 0 && (
            <div className={s.platformList}>
              {Object.entries(status.gateway_platforms).map(([name, plat]) => (
                <div key={name} className={s.platformItem}>
                  <span>{name}</span>
                  <b>{plat.state}</b>
                  {plat.error_message && <em>{plat.error_message}</em>}
                </div>
              ))}
            </div>
          )}
        </DebugCard>

        <DebugCard icon={<GitCommit size={15} />} title="最近提交" sub="显示 current.json 指向仓库的最近 5 条提交" wide>
          {source?.recentCommits.length ? (
            <div className={s.commitList}>
              {source.recentCommits.map((commit) => {
                const active = commit.hash === info?.current?.sourceCommit;
                return (
                  <div key={commit.hash} className={s.commitItem} data-active={active}>
                    <div className={s.commitHash}>
                      <code>{commit.shortHash}</code>
                      {active && <span><CheckCircle2 size={12} /> 已安装</span>}
                    </div>
                    <div className={s.commitSubject}>{commit.subject}</div>
                    <div className={s.commitMeta}>{commit.author} · {formatDateTime(commit.date)}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className={s.desc}>没有可读取的 Git 提交记录。发布版 runtime 可能只包含 artifact 元信息。</p>
          )}
        </DebugCard>

        <DebugCard icon={<Terminal size={15} />} title="路径与隔离边界" sub="确认 runtime 没有外溢到全局 hermes-agent" wide>
          <div className={s.runtimeGrid}>
            <RuntimeField label="runtimeRoot" value={info?.runtimeRoot ?? "—"} mono wide />
            <RuntimeField label="current.json" value={info?.currentRecordPath ?? "—"} mono wide />
            <RuntimeField label="versions" value={info?.versionsDir ?? "—"} mono wide />
            <RuntimeField label="downloads" value={info?.downloadsDir ?? "—"} mono wide />
            <RuntimeField label="gatewayRuntime" value={process?.gatewayRuntimeDir ?? info?.gatewayRuntimeDir ?? "—"} mono wide />
            <RuntimeField label="gatewayLockDir" value={process?.gatewayLockDir ?? "—"} mono wide />
            <RuntimeField label="executablePath" value={info?.current?.executablePath ?? "—"} mono wide />
            <RuntimeField label="previousRuntimeVersion" value={info?.current?.previousRuntimeVersion ?? "—"} wide />
          </div>
        </DebugCard>
      </div>
    </div>
  );
}

/* ── About ───────────────────────────────────────────────────────────── */

export function AboutSection({ showHeading = true }: SettingsSectionProps) {
  const [desktopUpdateResult, setDesktopUpdateResult] = useState<DesktopUpdateCheckResult | null>(null);
  const [desktopUpdateChecking, setDesktopUpdateChecking] = useState(false);
  const hasDesktopUpdateBridge = typeof window !== "undefined" && Boolean(window.hermesDesktop?.checkDesktopUpdate);

  const handleCheckDesktopUpdate = async () => {
    setDesktopUpdateChecking(true);
    try {
      setDesktopUpdateResult(await checkDesktopUpdate());
    } finally {
      setDesktopUpdateChecking(false);
    }
  };

  const handleOpenDesktopDownload = () => {
    void openExternalUrl(desktopUpdateResult?.downloadUrl ?? DESKTOP_UPDATE_DOWNLOAD_URL);
  };

  return (
    <div>
      {showHeading && <h2 className={s.heading}>关于</h2>}
      <div className={s.aboutHero}>
        <div className={s.aboutHeroMark}><Heart size={24} /></div>
        <div className={s.aboutHeroBody}>
          <div className={s.aboutEyebrow}>Hermes Agent 中文社区桌面版</div>
          <h3>联系与致谢</h3>
          <p>
            致谢，联系方式及项目链接。
          </p>
        </div>
      </div>

      <div className={s.aboutDebugGrid}>
        <DebugCard icon={<Download size={15} />} title="桌面端更新" sub="检查新版本并前往官网下载覆盖安装" wide>
          <div className={s.runtimeGrid}>
            <RuntimeField label="当前版本" value={versionLabel(DESKTOP_VERSION)} />
            <RuntimeField
              label="最新版本"
              value={desktopUpdateResult?.latestVersion ? versionLabel(desktopUpdateResult.latestVersion) : "—"}
            />
            <RuntimeField
              label="检查时间"
              value={formatDesktopUpdateCheckedAt(desktopUpdateResult?.checkedAtMs)}
            />
            <RuntimeField
              label="清单地址"
              value={desktopUpdateResult?.manifestUrl ?? "https://desktop.hermesagent.org.cn/latest.json"}
              mono
              wide
            />
          </div>
          <div
            className={s.runtimeMessage}
            data-tone={desktopUpdateResult && !desktopUpdateResult.ok ? "error" : "normal"}
          >
            {formatDesktopUpdateMessage(desktopUpdateResult, desktopUpdateChecking, hasDesktopUpdateBridge)}
          </div>
          <div className={s.providerActions}>
            <button
              className={s.btn}
              type="button"
              onClick={() => void handleCheckDesktopUpdate()}
              disabled={!hasDesktopUpdateBridge || desktopUpdateChecking}
            >
              <RefreshCw size={13} />
              {desktopUpdateChecking ? "检查中" : "检查更新"}
            </button>
            <button className={s.btnPrimary} type="button" onClick={handleOpenDesktopDownload}>
              <ExternalLinkIcon size={13} />
              去官网下载
            </button>
          </div>
          <p className={s.desc}>
            这里提醒的是桌面壳版本。下载新版安装包后，请按系统提示覆盖安装；应用不会自动下载安装包或替换正在运行的程序。
          </p>
        </DebugCard>

        <DebugCard icon={<Info size={15} />} title="致谢" sub="感谢支持和贡献" wide>
          <div className={s.thanksText}>
            <p>
              感谢 Hermes Agent 官方
              <ExternalTextLink href="https://nousresearch.com/">Nous Research</ExternalTextLink>
              的支持，以及参与测试、反馈、共建的中文社区朋友。
            </p>
            <p>
              感谢
              <ExternalTextLink href="https://github.com/MaxwellGengYF">MaxwellGeng</ExternalTextLink>
              的代码贡献，及
              <ExternalTextLink href="https://www.compshare.cn/">优云智算</ExternalTextLink>
              的支持。
            </p>
          </div>
        </DebugCard>

        <DebugCard icon={<MessageCircle size={15} />} title="联系方式" sub="社区入口和反馈渠道" wide>
          <div className={s.contactLayout}>
            <div className={s.runtimeGrid}>
              <ExternalLinkField label="官网" href="https://hermesagent.org.cn" text="hermesagent.org.cn" />
              <ContactField label="反馈">
                <ExternalTextLink href="https://github.com/Eynzof/hermes-agent-cn-desktop/issues">
                  到桌面端仓库 UI 层提交 issue 或建议
                </ExternalTextLink>
                <ExternalTextLink href="https://github.com/Eynzof/hermes-agent-cn/issues">
                  到桌面端内核仓库提交 issue 或建议
                </ExternalTextLink>
              </ContactField>
              <ContactField label="商务合作、企业定制化开发等" className={s.businessContactField}>
                <div className={s.businessContactLines}>
                  <ContactCopyLine label="电子邮箱" value="eynzof@gmail.com" />
                  <ContactCopyLine label="微信号" value="Eynzof" />
                </div>
              </ContactField>
            </div>
            <div className={s.wechatQrPanel}>
              <img src={wechatCommunityQr} alt="Hermes Agent 中文社区微信群二维码" />
              <p>这是 Hermes Agent 中文社区微信群入口，微信扫码即可加入。</p>
            </div>
          </div>
        </DebugCard>

        <DebugCard icon={<GitFork size={15} />} title="项目链接" sub="桌面端与内核项目" wide>
          <div className={s.runtimeGrid}>
            <ExternalLinkField
              label="桌面端"
              href="https://github.com/Eynzof/hermes-agent-cn-desktop"
              text="github.com/Eynzof/hermes-agent-cn-desktop"
              wide
            />
            <ExternalLinkField
              label="内核"
              href="https://github.com/Eynzof/hermes-agent-cn"
              text="github.com/Eynzof/hermes-agent-cn"
              wide
            />
          </div>
          <p className={s.desc}>
            桌面端会继续围绕中文社区的使用习惯做体验优化，也欢迎通过
            <ExternalTextLink href="https://github.com/Eynzof/hermes-agent-cn-desktop/issues">仓库反馈问题和建议</ExternalTextLink>。
          </p>
        </DebugCard>

        <DebugCard icon={<Globe2 size={15} />} title="中文社区" sub="本地化体验和使用文档" wide>
          <p className={s.desc}>
            中文社区桌面版会把常用配置、消息平台接入、运行状态和排障入口收进一个桌面工作台，尽量减少命令行门槛。
            后续社区入口和使用文档会同步到
            <ExternalTextLink href="https://hermesagent.org.cn">中文社区官网</ExternalTextLink>。
          </p>
        </DebugCard>
      </div>
    </div>
  );
}

function DebugCard({ icon, title, sub, children, wide }: {
  icon: React.ReactNode;
  title: string;
  sub?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={s.debugCard} data-wide={wide ? "true" : undefined}>
      <div className={s.debugCardHeader}>
        <div className={s.debugCardIcon}>{icon}</div>
        <div>
          <h3>{title}</h3>
          {sub && <p>{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function RuntimeField({ label, value, mono, wide }: {
  label: string;
  value: string | number | boolean | undefined;
  mono?: boolean;
  wide?: boolean;
}) {
  const display = value === undefined || value === "" ? "—" : String(value);
  return (
    <div className={s.runtimeField} data-wide={wide ? "true" : undefined}>
      <span>{label}</span>
      <b data-mono={mono ? "true" : undefined}>{display}</b>
    </div>
  );
}

function ExternalLinkField({ label, href, text, wide }: {
  label: string;
  href: string;
  text: string;
  wide?: boolean;
}) {
  return (
    <div className={s.runtimeField} data-wide={wide ? "true" : undefined}>
      <span>{label}</span>
      <b data-mono="true">
        <ExternalTextLink href={href}>{text}</ExternalTextLink>
      </b>
    </div>
  );
}

function ContactField({ label, children, className }: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`${s.runtimeField} ${className ?? ""}`} data-wide="true">
      <span>{label}</span>
      <div className={s.contactLines}>{children}</div>
    </div>
  );
}

function ContactCopyLine({ label, value }: { label: string; value: string }) {
  return (
    <div className={s.contactCopyLine}>
      <span className={s.contactCopyLabel}>{label}：</span>
      <b className={s.contactCopyValue}>{value}</b>
      <CopyButton className={s.contactCopyButton} text={value} showStatusIcon={false}>
        复制
      </CopyButton>
    </div>
  );
}

function ExternalTextLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      className={`${s.link} ${s.externalLink}`}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void openExternalUrl(href);
      }}
    >
      {children}
      <ExternalLinkIcon size={11} aria-hidden="true" />
    </a>
  );
}


function formatDesktopUpdateCheckedAt(value: number | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatDesktopUpdateMessage(
  result: DesktopUpdateCheckResult | null,
  checking: boolean,
  hasBridge: boolean,
): string {
  if (!hasBridge) return "当前环境没有桌面端更新检查能力；请直接前往官网查看最新版本。";
  if (checking) return "正在从官网读取最新桌面端版本…";
  if (!result) return "点击“检查更新”可手动读取官网最新版本。";
  if (!result.ok) return result.error ?? "桌面端更新检查失败。";
  if (result.updateAvailable) {
    return `发现新版本 ${versionLabel(result.latestVersion)}，可前往官网下载新版安装包覆盖安装。`;
  }
  return `当前已是最新版本 ${versionLabel(result.currentVersion)}。`;
}

function runtimeModeLabel(mode: RuntimeInfo["mode"] | undefined): string {
  switch (mode) {
    case "managed": return "托管运行";
    case "managed-pending": return "等待安装";
    case "external-command": return "外部命令";
    case "external-path": return "外部 PATH";
    case "dev-command": return "开发命令";
    case "dev-source": return "源码模式";
    case "path-fallback": return "PATH 回退";
    case "missing": return "未找到";
    default: return mode ?? "未知";
  }
}

function runtimeSourceLabel(source: string | undefined): string {
  switch (source) {
    case "local-source": return "本地源码安装";
    case "update": return "更新通道";
    case "bundled": return "安装包内置";
    case "managed": return "托管 runtime";
    default: return source ?? "unknown";
  }
}

function shortCommit(commit: string | undefined): string {
  return shortHash(commit, 12);
}

function shortHash(hash: string | undefined, length: number): string {
  return hash ? hash.slice(0, length) : "";
}

function formatDateTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatRuntimeUpdateResult(result: RuntimeUpdateCheckResult): string {
  if (!result.ok) return result.error ?? "runtime 更新检查失败";
  if (!result.updateAvailable) return `已是最新版本 ${result.currentRuntimeVersion ?? ""}`.trim();
  return `发现新 runtime ${result.manifest?.runtimeVersion ?? ""}`.trim();
}

/* ── Shared Components ───────────────────────────────────────────────── */

function Row({ label, sub, right }: { label: string; sub?: string; right: React.ReactNode }) {
  return (
    <div className={s.row}>
      <div className={s.rowLeft}>
        <div className={s.rowLabel}>{label}</div>
        {sub && <div className={s.rowSub}>{sub}</div>}
      </div>
      <div className={s.rowRight}>{right}</div>
    </div>
  );
}

function RadioGroup({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className={s.radioGroup}>
      {options.map((o) => (
        <button key={o.value} className={s.radioBtn} data-active={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

function ConfigFieldRow({ fieldKey, field, value, onSave, showCategory }: {
  fieldKey: string; field: ConfigSchemaField; value: any; onSave: (val: any) => void; showCategory?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [localVal, setLocalVal] = useState(String(value ?? ""));

  const handleSave = () => {
    let parsed: any = localVal;
    if (field.type === "number") parsed = Number(localVal);
    if (field.type === "boolean") parsed = localVal === "true";
    onSave(parsed);
    setEditing(false);
  };

  const label = translateConfigField(fieldKey, field.description || fieldKey);

  if (field.type === "select" && field.options) {
    return (
      <Row
        label={label}
        sub={showCategory ? `[${CATEGORY_CN[field.category] ?? field.category}] ${fieldKey}` : fieldKey}
        right={<select className={s.select} value={String(value ?? "")} onChange={(e) => onSave(e.target.value)}>{field.options.map((o) => <option key={o} value={o}>{translateConfigOption(fieldKey, o)}</option>)}</select>}
      />
    );
  }

  if (field.type === "boolean") {
    return (
      <Row
        label={label}
        sub={showCategory ? `[${CATEGORY_CN[field.category] ?? field.category}] ${fieldKey}` : fieldKey}
        right={<button className={s.toggle} data-on={!!value} onClick={() => onSave(!value)}><span className={s.toggleThumb} /></button>}
      />
    );
  }

  return (
    <Row
      label={label}
      sub={showCategory ? `[${CATEGORY_CN[field.category] ?? field.category}] ${fieldKey}` : fieldKey}
      right={editing ? (
        <div style={{ display: "flex", gap: 6 }}>
          <input className={s.input} data-mono value={localVal} onChange={(e) => setLocalVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSave()} autoFocus style={{ width: 200 }} />
          <button className={s.btnPrimary} onClick={handleSave}>保存</button>
          <button className={s.btn} onClick={() => setEditing(false)}>取消</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontFamily: "var(--h-font-mono)", fontSize: 12, color: "var(--h-text-2)" }}>{value != null ? String(value) : "—"}</span>
          <button className={s.btn} onClick={() => { setLocalVal(String(value ?? "")); setEditing(true); }}>编辑</button>
        </div>
      )}
    />
  );
}

function FieldRow({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div className={s.fieldRow}>
      <div className={s.fieldLabel}>{label}</div>
      <input className={s.fieldInput} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

/* ── Utilities ───────────────────────────────────────────────────────── */

function getNestedValue(obj: any, path: string): any {
  if (!obj) return undefined;
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

function groupBy<T>(arr: T[], fn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = fn(item);
    (result[key] ??= []).push(item);
  }
  return result;
}
