import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { AlertTriangle, CheckCircle2, Copy, FolderOpen, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import type {
  ConfigMigrationCandidate,
  ConfigMigrationImportResult,
  ConfigMigrationScanResult,
} from "@hermes/protocol";
import { Alert, Button } from "@hermes/shared-ui";
import { runtime } from "@/lib/runtime";
import { buildConfigMigrationAssistantPrompt } from "@/lib/config-migration-assistant";
import { forceExistingGatewayReconnect } from "@/lib/gateway-client";
import { reloadUiStore } from "@/lib/ui-store";
import { activeProfileAtom, profileSwitchingAtom } from "@/stores/ui";
import { composerPrefillAtom } from "@/stores/panel";
import { SectionShell } from "./section-shell";
import { SettingsHero } from "./settings-hero";
import settings from "./settings.module.css";
import s from "./config-migration.module.css";

function formatBytes(value: number | undefined): string {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function sourceKindLabel(kind: string): string {
  switch (kind) {
    case "wsl":
      return "WSL";
    case "manual":
      return "手动";
    case "env":
      return "HERMES_HOME";
    default:
      return "本机";
  }
}

function candidateSummary(candidate: ConfigMigrationCandidate): string[] {
  const parts: string[] = [];
  if (candidate.hasConfig) parts.push("config.yaml");
  if (candidate.hasEnv) parts.push(".env");
  if (candidate.hasAuth) parts.push("auth.json");
  if (candidate.hasSkills) parts.push("skills");
  if (candidate.hasMemories) parts.push("memories");
  return parts;
}

function CandidateCard({
  candidate,
  active,
  onSelect,
}: {
  candidate: ConfigMigrationCandidate;
  active: boolean;
  onSelect: () => void;
}) {
  const summary = candidateSummary(candidate);
  const hasSecrets = candidate.copyEntries.some((entry) => entry.containsSecrets);
  return (
    <button
      type="button"
      className={s.candidateCard}
      data-active={active ? "true" : undefined}
      onClick={onSelect}
    >
      <div className={s.candidateHead}>
        <span className={s.candidateTitle}>{candidate.label}</span>
        {active && <CheckCircle2 size={15} />}
      </div>
      <div className={s.pathText}>{candidate.path}</div>
      <div className={s.badgeRow}>
        <span className={s.badge}>{sourceKindLabel(candidate.sourceKind)}</span>
        {summary.map((item) => <span key={item} className={s.badge}>{item}</span>)}
        {hasSecrets && <span className={s.secretBadge}>包含密钥</span>}
      </div>
      <div className={s.codeText}>建议目标 profile：{candidate.recommendedTargetProfile}</div>
    </button>
  );
}

function MigrationPreview({
  candidate,
  importing,
  onImport,
}: {
  candidate: ConfigMigrationCandidate;
  importing: boolean;
  onImport: () => void;
}) {
  const hasSecrets = candidate.copyEntries.some((entry) => entry.containsSecrets);
  return (
    <section className={s.previewPanel}>
      <h3 className={s.previewTitle}>迁移预览</h3>
      <p className={s.introText}>
        将从 <code>{candidate.path}</code> 复制配置到桌面端的独立目录。已有桌面端配置不会被覆盖；如果当前档案已配置，会自动导入到一个新档案。
      </p>
      {hasSecrets && (
        <Alert tone="warning" size="sm">
          <AlertTriangle size={14} /> 此来源包含 <code>.env</code> 或 <code>auth.json</code>，导入后这些密钥只会写入桌面端的独立目录。
        </Alert>
      )}
      <div className={s.entryList}>
        {candidate.copyEntries.map((entry) => (
          <div key={entry.path} className={s.entryItem}>
            <span>{entry.path}{entry.containsSecrets ? " · 密钥" : ""}</span>
            <span className={s.entryMeta}>{entry.kind} · {formatBytes(entry.sizeBytes)}</span>
          </div>
        ))}
      </div>
      {candidate.warnings.length > 0 && (
        <ul className={s.warningList}>
          {candidate.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
      <div className={s.actions}>
        <Button type="button" variant="solid" tone="accent" onClick={onImport} disabled={importing}>
          <ShieldCheck size={13} />
          {importing ? "迁移中…" : "确认迁移并切换"}
        </Button>
      </div>
    </section>
  );
}

function LegacyConfigMigrationRoute() {
  const queryClient = useQueryClient();
  const setActiveProfile = useSetAtom(activeProfileAtom);
  const setSwitching = useSetAtom(profileSwitchingAtom);
  const [scanResult, setScanResult] = useState<ConfigMigrationScanResult | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [lastImport, setLastImport] = useState<ConfigMigrationImportResult | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    // StrictMode（dev）会模拟 mount→unmount→remount，卸载时已把 mountedRef 置 false，
    // 必须在重新挂载时复位为 true，否则后续 scan 完成时会被 `!mountedRef.current` 拦掉，
    // 页面永远停在“扫描中”。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const candidates = scanResult?.candidates ?? [];
  const selected = useMemo(
    () => candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0] ?? null,
    [candidates, selectedId],
  );

  useEffect(() => {
    if (!selectedId && candidates[0]) setSelectedId(candidates[0].id);
  }, [candidates, selectedId]);

  const scan = async (manualPath?: string) => {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const api = window.hermesDesktop?.scanConfigMigration;
      if (!api) throw new Error("当前环境不支持桌面端配置迁移。请在 Tauri 桌面端中使用此功能。");
      const result = await api(manualPath ? { manualPath } : undefined);
      if (!mountedRef.current) return;
      setScanResult(result);
      setSelectedId(result.candidates[0]?.id ?? null);
      if (result.candidates.length === 0) {
        setMessage("没有自动发现可迁移的 Hermes 配置。可以用“手动选择目录”指定已有 .hermes 目录。");
      }
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : "扫描失败");
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void scan(), 250);
    return () => window.clearTimeout(timer);
  }, []);

  const chooseManualDirectory = async () => {
    setError("");
    const picker = window.hermesDesktop?.pickDirectory;
    if (!picker) {
      setError("当前环境不支持原生目录选择。请在桌面端中使用此功能。");
      return;
    }
    const result = await picker();
    const path = result.paths[0];
    if (!result.canceled && path) await scan(path);
  };

  const importSelected = async () => {
    if (!selected) return;
    setImporting(true);
    setError("");
    setMessage("");
    setLastImport(null);
    setSwitching({ active: true, targetName: selected.recommendedTargetProfile });
    try {
      const api = window.hermesDesktop?.importConfigMigration;
      if (!api) throw new Error("当前环境不支持桌面端配置迁移。");
      const result = await api({
        sourcePath: selected.path,
        recommendedTargetProfile: selected.recommendedTargetProfile,
      });
      setLastImport(result);
      if (!result.ok) throw new Error(result.error || "迁移失败");
      runtime.applyConfigMigrationResult(result);
      forceExistingGatewayReconnect("config-migration");
      if (result.targetProfileName) setActiveProfile(result.targetProfileName);
      await reloadUiStore();
      await queryClient.invalidateQueries();
      setMessage(`已迁移到 profile ${result.targetProfileName ?? "default"}，并重启 dashboard。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "迁移失败");
    } finally {
      setSwitching({ active: false });
      setImporting(false);
    }
  };

  const sub = scanResult
    ? `${scanResult.candidates.length} 个候选 · 当前 ${scanResult.currentProfile}`
    : loading
      ? "扫描中…"
      : "从本机或 WSL 的 Hermes 安装复制配置包";

  return (
    <SectionShell title="配置迁移" sub={sub}>
      <SettingsHero
        ok={!loading && !importing}
        icon={<ShieldCheck size={24} />}
        eyebrow="Hermes Agent 配置迁移"
        title="把已有 Hermes 配置复制到桌面端内核"
        description="桌面端使用独立内核，不会直接读取系统全局的 ~/.hermes。这里会在你确认后复制配置、密钥、技能和记忆，避免重新配置模型 API Key。"
        badge={<span className={settings.statusBadge} data-on={!loading && !importing}>{loading ? "扫描中" : importing ? "迁移中" : `${candidates.length} 个候选`}</span>}
      />

      <div className={s.actions}>
        <Button type="button" variant="outline" onClick={() => scan()} disabled={loading || importing}>
          <RefreshCw size={13} />
          {loading ? "扫描中…" : "重新扫描"}
        </Button>
        <Button type="button" variant="outline" onClick={chooseManualDirectory} disabled={loading || importing}>
          <FolderOpen size={13} />
          手动选择目录
        </Button>
      </div>

      {message && <Alert tone={lastImport?.ok ? "success" : "neutral"} size="sm">{message}</Alert>}
      {error && <Alert tone="danger" size="sm">{error}</Alert>}
      {scanResult?.warnings.map((warning) => <Alert key={warning} tone="warning" size="sm">{warning}</Alert>)}

      <div className={s.candidateGrid}>
        {candidates.map((candidate) => (
          <CandidateCard
            key={candidate.id}
            candidate={candidate}
            active={selected?.id === candidate.id}
            onSelect={() => setSelectedId(candidate.id)}
          />
        ))}
      </div>

      {selected && <MigrationPreview candidate={selected} importing={importing} onImport={importSelected} />}

      {lastImport?.ok && (
        <div className={s.previewPanel}>
          <h3 className={s.previewTitle}>迁移结果</h3>
          <p className={s.introText}>已导入 {lastImport.importedEntries.length} 项：{lastImport.importedEntries.join("、")}</p>
          {lastImport.warnings.length > 0 && (
            <ul className={s.warningList}>
              {lastImport.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}
        </div>
      )}
    </SectionShell>
  );
}

async function buildPromptFromCurrentRuntime(): Promise<string> {
  const runtimeConfig = window.hermesDesktop?.getRuntimeConfig?.() ?? window.__HERMES_RUNTIME__ ?? null;
  const runtimeInfo = await window.hermesDesktop?.getRuntimeInfo?.().catch(() => null) ?? null;
  return buildConfigMigrationAssistantPrompt({
    runtimeConfig,
    runtimeInfo,
    collectedAt: new Date().toISOString(),
  });
}

function ConfigMigrationAssistantRoute() {
  const navigate = useNavigate();
  const setPrefill = useSetAtom(composerPrefillAtom);
  const [preparing, setPreparing] = useState(false);
  const [copying, setCopying] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const startMigrationGuide = useCallback(async () => {
    if (preparing) return;
    setPreparing(true);
    setMessage("");
    setError("");
    try {
      const prompt = await buildPromptFromCurrentRuntime();
      setPrefill({ text: prompt, nonce: Date.now() });
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法准备迁移说明，请稍后重试");
    } finally {
      setPreparing(false);
    }
  }, [navigate, preparing, setPrefill]);

  const copyPrompt = useCallback(async () => {
    setCopying(true);
    setMessage("");
    setError("");
    try {
      const prompt = await buildPromptFromCurrentRuntime();
      await navigator.clipboard.writeText(prompt);
      setMessage("已复制迁移说明。你可以把它粘贴到任意 Hermes 对话中使用。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "复制迁移说明失败");
    } finally {
      setCopying(false);
    }
  }, []);

  return (
    <SectionShell title="配置迁移" sub="把已有 Hermes 配置安全迁移到当前桌面端">
      <SettingsHero
        ok={!preparing}
        icon={<Sparkles size={24} />}
        eyebrow="Hermes Agent 配置迁移"
        title="让 Hermes 帮你迁移已有配置"
        description="如果你以前在命令行版、其它档案或其它目录里配置过模型、密钥、MCP、技能或记忆，可以从这里开始迁移。系统会把一段迁移说明填入新任务输入框，你确认后再发送给 Hermes。"
        badge={<span className={settings.statusBadge} data-on={!preparing}>{preparing ? "准备中" : "向导"}</span>}
      />

      <div className={s.actions}>
        <Button type="button" variant="solid" tone="accent" onClick={startMigrationGuide} disabled={preparing}>
          <Sparkles size={13} />
          {preparing ? "正在准备…" : "开始迁移向导"}
        </Button>
        <Button type="button" variant="outline" onClick={copyPrompt} disabled={preparing || copying}>
          <Copy size={13} />
          {copying ? "正在复制…" : "复制迁移说明"}
        </Button>
      </div>

      {message && <Alert tone="success" size="sm">{message}</Alert>}
      {error && <Alert tone="danger" size="sm">{error}</Alert>}

      <div className={s.assistantGrid}>
        <section className={s.previewPanel}>
          <h3 className={s.previewTitle}>适合迁移的内容</h3>
          <div className={s.entryList}>
            <div className={s.entryItem}>
              <span>模型和密钥</span>
              <span className={s.entryMeta}>服务商 / API Key / Base URL</span>
            </div>
            <div className={s.entryItem}>
              <span>工具和扩展</span>
              <span className={s.entryMeta}>MCP / skills / plugins / scripts</span>
            </div>
            <div className={s.entryItem}>
              <span>个性化数据</span>
              <span className={s.entryMeta}>记忆 / 灵魂 / 常用配置</span>
            </div>
          </div>
        </section>

        <section className={s.previewPanel}>
          <h3 className={s.previewTitle}>迁移会怎样进行</h3>
          <div className={s.stepList}>
            <div><b>1. 先检查来源</b><span>Hermes 会帮你确认旧配置可能保存在哪里。</span></div>
            <div><b>2. 再给迁移建议</b><span>哪些可以直接迁移，哪些需要你确认或手动调整。</span></div>
            <div><b>3. 确认后再修改</b><span>没有你的确认，不会改文件、覆盖配置或重启服务。</span></div>
            <div><b>4. 最后验证结果</b><span>检查模型、工具、技能和记忆是否能正常使用。</span></div>
          </div>
        </section>
      </div>

      <section className={s.promptPanel}>
        <h3 className={s.previewTitle}>迁移前请注意</h3>
        <p className={s.introText}>
          迁移过程中可能会涉及 API Key、登录凭据和本地文件路径。Hermes 会优先使用只读检查，并在需要写入或覆盖文件前向你确认。
        </p>
      </section>
    </SectionShell>
  );
}

export function ConfigMigrationRoute() {
  const [searchParams] = useSearchParams();
  if (searchParams.get("legacy") === "1") return <LegacyConfigMigrationRoute />;
  return <ConfigMigrationAssistantRoute />;
}
