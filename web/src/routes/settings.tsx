import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useAtom, useAtomValue } from "jotai";
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
  RotateCcw,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { Dialog, useTheme, type ThemeConfig } from "@hermes/shared-ui";
import { useConfig, useConfigSchema, useSaveConfig } from "@/hooks/use-config";
import { useSkills, useToggleSkill } from "@/hooks/use-skills";
import { useCronJobs, useCreateCronJob, useDeleteCronJob, useCronAction } from "@/hooks/use-cron";
import { useLogs } from "@/hooks/use-logs";
import { useStatus } from "@/hooks/use-status";
import { useYoloMode, useSetYoloMode, isYoloModeSupported } from "@/hooks/use-yolo-mode";
import {
  useCheckRuntimeUpdate,
  useInstallRuntimeUpdate,
  useRollbackRuntime,
  useRuntimeInfo,
} from "@/hooks/use-runtime-update";
import { composerSubmitShortcutAtom, showReasoningAtom, profileSwitchingAtom } from "@/stores/ui";
import { postJSON } from "@/lib/transport";
import { openExternalUrl } from "@/lib/external-links";
import { buildNestedConfigUpdate, mergeConfigUpdate } from "@/lib/config-update";
import { translateConfigField, translateConfigOption } from "@/lib/config-translations";
import type { ComposerSubmitShortcut } from "@/lib/composer-submit-shortcut";
import type { ConfigSchemaField, RuntimeInfo, RuntimeUpdateCheckResult } from "@hermes/protocol";
import { CopyButton } from "@/components/ui/copy-button";
import wechatCommunityQr from "@/assets/wechat-community-qr.png";
import s from "./settings.module.css";

/* ── General ─────────────────────────────────────────────────────────── */

interface SettingsSectionProps {
  showHeading?: boolean;
}

export function GeneralSection({ showHeading = true }: SettingsSectionProps) {
  const { config, update } = useTheme();
  const [showReasoning, setShowReasoning] = useAtom(showReasoningAtom);
  const [composerSubmitShortcut, setComposerSubmitShortcut] = useAtom(composerSubmitShortcutAtom);

  return (
    <div>
      {showHeading && <h2 className={s.heading}>常规</h2>}
      <Row label="主题" right={
        <RadioGroup value={config.theme} options={[{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }]} onChange={(v) => update({ theme: v as ThemeConfig["theme"] })} />
      } />
      <Row label="信息密度" right={
        <RadioGroup value={config.density} options={[{ value: "compact", label: "紧凑" }, { value: "comfortable", label: "舒适" }]} onChange={(v) => update({ density: v as ThemeConfig["density"] })} />
      } />
      <Row label="显示推理过程" sub="在会话中展示模型的思考和推理内容" right={
        <RadioGroup value={showReasoning ? "on" : "off"} options={[{ value: "off", label: "隐藏" }, { value: "on", label: "显示" }]} onChange={(v) => setShowReasoning(v === "on")} />
      } />
      <Row label="发送快捷键" sub="控制对话输入框的提交方式；未触发发送的 Enter 会保留为换行。" right={
        <RadioGroup value={composerSubmitShortcut} options={[{ value: "enter", label: "Enter 发送" }, { value: "ctrl-enter", label: "Ctrl+Enter 发送" }]} onChange={(v) => setComposerSubmitShortcut(v as ComposerSubmitShortcut)} />
      } />
      {isYoloModeSupported() && <YoloDangerZone />}
    </div>
  );
}

/* ── Danger zone: YOLO mode ──────────────────────────────────────────── */

const YOLO_DESC =
  "自动批准所有危险命令（等同后端 --yolo / HERMES_YOLO_MODE）。开启后 Agent 执行 shell、删除文件等高危操作时不再二次确认，切换会重启内核。请仅在受信任的工作区使用。";

function YoloDangerZone() {
  const { data: yolo } = useYoloMode();
  const setYolo = useSetYoloMode();
  // A profile switch and a YOLO toggle both restart the dashboard and share
  // this overlay; block the controls while either restart is in flight so we
  // don't kick off a second restart (or tear the overlay down early).
  const restartInFlight = useAtomValue(profileSwitchingAtom).active;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const enabled = !!yolo?.enabled;
  const pending = yolo != null && yolo.enabled !== yolo.effective;
  const busy = setYolo.isPending || restartInFlight;

  const openConfirm = () => {
    if (busy) return;
    setAcknowledged(false);
    setConfirmOpen(true);
  };
  const confirmEnable = () => {
    setConfirmOpen(false);
    setYolo.mutate(true);
  };

  return (
    <div className={s.dangerZone}>
      <div className={s.dangerZoneHead}>
        <AlertTriangle size={14} aria-hidden="true" />
        高风险操作
      </div>
      <Row
        label="YOLO 模式"
        sub={YOLO_DESC + (pending ? "（已保存，重启桌面端后生效）" : "")}
        right={
          enabled ? (
            <div className={s.dangerActions}>
              <span className={pending ? s.dangerBadgePending : s.dangerBadge}>
                {pending ? "待生效" : "已开启"}
              </span>
              <button className={s.btn} disabled={busy} onClick={() => !busy && setYolo.mutate(false)}>
                关闭
              </button>
            </div>
          ) : (
            <button className={s.btnDanger} disabled={busy} onClick={openConfirm}>
              开启
            </button>
          )
        }
      />

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
              <button className={s.btnDanger} disabled={!acknowledged} onClick={confirmEnable}>
                确认开启
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
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
        <div className={s.configTabs}>
          {categories.map((cat) => (
            <button key={cat} className={s.configTab} data-active={cat === activeCategory} onClick={() => setActiveCategory(cat)}>
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

export function CronSection() {
  const { data: jobs, isLoading } = useCronJobs();
  const createJob = useCreateCronJob();
  const deleteJob = useDeleteCronJob();
  const cronAction = useCronAction();
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSchedule, setNewSchedule] = useState("");
  const [newPrompt, setNewPrompt] = useState("");

  const handleCreate = () => {
    if (!newSchedule || !newPrompt) return;
    createJob.mutate({ name: newName || undefined, schedule: newSchedule, prompt: newPrompt });
    setShowNew(false);
    setNewName("");
    setNewSchedule("");
    setNewPrompt("");
  };

  return (
    <div>
      <p className={s.desc}>Agent 会按计划自动执行这些任务。</p>
      {isLoading && <div className={s.desc}>加载中…</div>}
      {jobs && jobs.length === 0 && !showNew && <div className={s.desc}>暂无定时任务。</div>}
      {jobs?.map((job) => (
        <div key={job.id} className={s.row}>
          <div className={s.rowLeft}>
            <div className={s.rowLabel}>{job.name || job.id}</div>
            <div className={s.rowSub}>{job.schedule} · {job.prompt?.slice(0, 60)}</div>
          </div>
          <div className={s.rowRight} style={{ gap: 6 }}>
            <span className={s.statusBadge} data-on={job.enabled}>{job.enabled ? "启用" : "暂停"}</span>
            <button className={s.btn} onClick={() => cronAction.mutate({ id: job.id, action: job.enabled ? "pause" : "resume" })}>
              {job.enabled ? "暂停" : "恢复"}
            </button>
            <button className={s.btn} onClick={() => cronAction.mutate({ id: job.id, action: "trigger" })}>触发</button>
            <button className={s.btnDanger} onClick={() => deleteJob.mutate(job.id)}>删除</button>
          </div>
        </div>
      ))}
      {showNew ? (
        <div className={s.providerDetail} style={{ marginTop: 12 }}>
          <FieldRow label="名称（可选）" value={newName} onChange={setNewName} />
          <FieldRow label="Cron 表达式" value={newSchedule} onChange={setNewSchedule} placeholder="0 9 * * *" />
          <FieldRow label="Prompt" value={newPrompt} onChange={setNewPrompt} placeholder="每天执行的任务描述…" />
          <div className={s.providerActions}>
            <button className={s.btnPrimary} onClick={handleCreate}>创建</button>
            <button className={s.btn} onClick={() => setShowNew(false)}>取消</button>
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
  const [restarting, setRestarting] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [aboutMessage, setAboutMessage] = useState("");

  const handleRestart = async () => {
    setRestarting(true);
    try { await postJSON("/api/gateway/restart", {}); }
    finally { setTimeout(() => setRestarting(false), 3000); }
  };

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
        <button className={s.btnPrimary} onClick={handleRestart} disabled={restarting}>
          <RotateCcw size={13} />
          {restarting ? "重启中…" : "重启 Gateway"}
        </button>
      </div>
      {aboutMessage && <div className={s.runtimeMessage} data-tone="error">{aboutMessage}</div>}

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
