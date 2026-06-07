import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { AlertTriangle, CheckCircle2, Copy, FolderOpen, Play, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import type {
  ConfigMigrationCandidate,
  ConfigMigrationImportResult,
  ConfigMigrationScanResult,
} from "@hermes/protocol";
import { runtime } from "@/lib/runtime";
import { buildConfigMigrationAssistantPrompt, CONFIG_MIGRATION_ASSISTANT_TITLE } from "@/lib/config-migration-assistant";
import { forceExistingGatewayReconnect } from "@/lib/gateway-client";
import { reloadUiStore } from "@/lib/ui-store";
import { activeProfileAtom, activeSessionIdAtom, profileSwitchingAtom } from "@/stores/ui";
import { setSessionComposerDraftAtom } from "@/stores/panel";
import { useGateway } from "@/hooks/use-gateway";
import { SectionShell } from "./section-shell";
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
        将从 <code>{candidate.path}</code> 复制配置包到桌面端独立 Hermes home。已有桌面端配置不会被覆盖；如果当前 profile 已配置，后端会自动导入到新 profile。
      </p>
      {hasSecrets && (
        <div className={s.notice}>
          <AlertTriangle size={14} /> 此来源包含 <code>.env</code> 或 <code>auth.json</code>，导入后这些密钥只会写入桌面端 managed runtime 的独立目录。
        </div>
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
        <button type="button" className={settings.btnPrimary} onClick={onImport} disabled={importing}>
          <ShieldCheck size={13} />
          {importing ? "迁移中…" : "确认迁移并切换"}
        </button>
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
      setScanResult(result);
      setSelectedId(result.candidates[0]?.id ?? null);
      if (result.candidates.length === 0) {
        setMessage("没有自动发现可迁移的 Hermes 配置。可以用“手动选择目录”指定已有 .hermes 目录。");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "扫描失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void scan();
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
      <div className={s.introCard}>
        <h2 className={s.introTitle}>把已经安装的 Hermes 配置复制到桌面端内核</h2>
        <p className={s.introText}>
          桌面端使用独立 managed runtime，不会直接读取用户全局 <code>~/.hermes</code>。这里会在用户确认后复制配置、密钥、技能和记忆文件，避免重新配置模型 API Key。
        </p>
      </div>

      <div className={s.actions}>
        <button type="button" className={settings.btn} onClick={() => scan()} disabled={loading || importing}>
          <RefreshCw size={13} />
          {loading ? "扫描中…" : "重新扫描"}
        </button>
        <button type="button" className={settings.btn} onClick={chooseManualDirectory} disabled={loading || importing}>
          <FolderOpen size={13} />
          手动选择目录
        </button>
      </div>

      {message && <div className={lastImport?.ok ? s.success : s.notice}>{message}</div>}
      {error && <div className={s.error}>{error}</div>}
      {scanResult?.warnings.map((warning) => <div key={warning} className={s.notice}>{warning}</div>)}

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
  const { createSession, setSessionTitle } = useGateway();
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const setSessionComposerDraft = useSetAtom(setSessionComposerDraftAtom);
  const [opening, setOpening] = useState(false);
  const [copying, setCopying] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const openAssistantSession = useCallback(async () => {
    if (opening) return;
    setOpening(true);
    setMessage("");
    setError("");
    try {
      const prompt = await buildPromptFromCurrentRuntime();
      const sessionId = await createSession();
      setSessionComposerDraft({ sessionId, text: prompt });
      setActiveSessionId(sessionId);
      void setSessionTitle(sessionId, CONFIG_MIGRATION_ASSISTANT_TITLE).catch(() => {});
      navigate(`/tasks/${sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法打开配置迁移助手会话");
    } finally {
      setOpening(false);
    }
  }, [createSession, navigate, opening, setActiveSessionId, setSessionComposerDraft, setSessionTitle]);

  const copyPrompt = useCallback(async () => {
    setCopying(true);
    setMessage("");
    setError("");
    try {
      const prompt = await buildPromptFromCurrentRuntime();
      await navigator.clipboard.writeText(prompt);
      setMessage("已复制迁移助手提示词。你也可以手动粘贴到任意 Hermes 会话中使用。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "复制提示词失败");
    } finally {
      setCopying(false);
    }
  }, []);

  return (
    <SectionShell title="配置迁移" sub="用 Hermes Agent 会话完成复杂环境下的迁移诊断和执行">
      <div className={s.heroCard}>
        <div className={s.heroIcon}><Sparkles size={22} /></div>
        <div>
          <h2 className={s.heroTitle}>把“自动复制配置”改成“迁移助手会话”。</h2>
          <p className={s.heroText}>
            用户环境里的 Hermes 配置可能分散在全局目录、多个 profile、WSL、旧安装目录、MCP 脚本和 OAuth 文件里。这里不再用固定白名单直接复制，
            而是打开一个预置提示词的新会话，让 Hermes Agent 先盘点、再给迁移计划，等你确认后再执行。
          </p>
        </div>
      </div>

      <div className={s.actions}>
        <button type="button" className={settings.btnPrimary} onClick={openAssistantSession} disabled={opening}>
          <Play size={13} />
          {opening ? "正在打开…" : "打开迁移助手会话"}
        </button>
        <button type="button" className={settings.btn} onClick={copyPrompt} disabled={opening || copying}>
          <Copy size={13} />
          {copying ? "正在复制…" : "复制提示词"}
        </button>
      </div>

      {message && <div className={s.success}>{message}</div>}
      {error && <div className={s.error}>{error}</div>}

      <div className={s.assistantGrid}>
        <section className={s.previewPanel}>
          <h3 className={s.previewTitle}>这次改造解决什么问题</h3>
          <div className={s.entryList}>
            <div className={s.entryItem}>
              <span>多来源配置</span>
              <span className={s.entryMeta}>全局 / profile / WSL / 旧目录</span>
            </div>
            <div className={s.entryItem}>
              <span>路径和命令差异</span>
              <span className={s.entryMeta}>MCP / scripts / browser tools</span>
            </div>
            <div className={s.entryItem}>
              <span>密钥和 OAuth</span>
              <span className={s.entryMeta}>只脱敏展示，先确认再迁移</span>
            </div>
          </div>
        </section>

        <section className={s.previewPanel}>
          <h3 className={s.previewTitle}>会话内默认工作流</h3>
          <div className={s.stepList}>
            <div><b>1. 只读诊断</b><span>先确认当前 profile、目标 HERMES_HOME 和候选来源。</span></div>
            <div><b>2. 迁移计划</b><span>说明来源、目标、备份位置、风险和回滚方式。</span></div>
            <div><b>3. 用户确认</b><span>没有确认前不写文件、不重启、不覆盖现有配置。</span></div>
            <div><b>4. 执行验证</b><span>迁移后检查模型、MCP、skills、memory 和 gateway 状态。</span></div>
          </div>
        </section>
      </div>

      <section className={s.promptPanel}>
        <h3 className={s.previewTitle}>预置提示词策略</h3>
        <p className={s.introText}>
          新会话会把完整提示词放进输入框，但不会自动发送。你可以先补充旧配置路径、希望迁移的 profile，或删掉不相关的要求，再手动提交。
        </p>
        <div className={s.notice}>
          <ShieldCheck size={14} /> 旧版原生扫描/复制逻辑仍保留为内部 fallback；常规用户入口只显示迁移助手，避免在复杂环境里误导用户“一键导入即可”。
        </div>
      </section>
    </SectionShell>
  );
}

export function ConfigMigrationRoute() {
  const [searchParams] = useSearchParams();
  if (searchParams.get("legacy") === "1") return <LegacyConfigMigrationRoute />;
  return <ConfigMigrationAssistantRoute />;
}
