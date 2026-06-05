import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { AlertTriangle, CheckCircle2, FolderOpen, RefreshCw, ShieldCheck } from "lucide-react";
import type {
  ConfigMigrationCandidate,
  ConfigMigrationImportResult,
  ConfigMigrationScanResult,
} from "@hermes/protocol";
import { runtime } from "@/lib/runtime";
import { forceExistingGatewayReconnect } from "@/lib/gateway-client";
import { reloadUiStore } from "@/lib/ui-store";
import { activeProfileAtom, profileSwitchingAtom } from "@/stores/ui";
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

export function ConfigMigrationRoute() {
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
