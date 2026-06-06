import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { AlertTriangle, Archive, CheckCircle2, Download, FolderOpen, Upload } from "lucide-react";
import type { BackupExportResult, BackupImportResult } from "@hermes/protocol";
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
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function containingDirectory(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/[\\/]+$/, "");
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (slash < 0) return undefined;
  if (slash === 0) return normalized.slice(0, 1);
  if (slash === 2 && /^[A-Za-z]:[\\/]/.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, slash);
}

async function openBackupDirectory(path: string | undefined): Promise<string | null> {
  const target = containingDirectory(path) ?? path;
  if (!target || !window.hermesDesktop?.openWorkspacePath) return null;
  const result = await window.hermesDesktop.openWorkspacePath({ path: target });
  if (result.ok) return null;
  return result.body || result.statusText || "无法打开文件夹";
}

export function BackupRoute() {
  const queryClient = useQueryClient();
  const setActiveProfile = useSetAtom(activeProfileAtom);
  const setSwitching = useSetAtom(profileSwitchingAtom);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [lastExport, setLastExport] = useState<BackupExportResult | null>(null);
  const [lastImport, setLastImport] = useState<BackupImportResult | null>(null);

  const exportBackup = async () => {
    setExporting(true);
    setMessage("");
    setError("");
    setLastExport(null);
    setLastImport(null);
    try {
      const api = window.hermesDesktop?.exportProfileBackup;
      if (!api) throw new Error("当前环境不支持桌面端备份导出。请在 Tauri 桌面端中使用此功能。");
      const result = await api();
      setLastExport(result);
      if (result.canceled) {
        setMessage("已取消导出。");
        return;
      }
      if (!result.ok) throw new Error(result.error || "导出备份失败");
      const openError = await openBackupDirectory(result.backupPath);
      setMessage(
        openError
          ? `已导出当前档案 ${result.profileName ?? ""} 的备份压缩包，但自动打开文件夹失败：${openError}`
          : `已导出当前档案 ${result.profileName ?? ""} 的备份压缩包，并已打开所在文件夹。`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出备份失败");
    } finally {
      setExporting(false);
    }
  };

  const importBackup = async () => {
    setImporting(true);
    setMessage("");
    setError("");
    setLastImport(null);
    setLastExport(null);
    setSwitching({ active: true, targetName: "备份恢复" });
    try {
      const api = window.hermesDesktop?.importProfileBackup;
      if (!api) throw new Error("当前环境不支持桌面端备份导入。请在 Tauri 桌面端中使用此功能。");
      const result = await api();
      setLastImport(result);
      if (result.canceled) {
        setMessage("已取消导入。");
        return;
      }
      runtime.applyBackupImportResult(result);
      if (result.recoveredPreviousProfile) forceExistingGatewayReconnect("backup-import-recovery");
      if (!result.ok) throw new Error(result.error || "导入备份失败");
      forceExistingGatewayReconnect("backup-import");
      if (result.targetProfileName) setActiveProfile(result.targetProfileName);
      await reloadUiStore();
      await queryClient.invalidateQueries();
      setMessage(`已恢复到新 profile ${result.targetProfileName ?? "restored"}，并重启 dashboard。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入备份失败");
    } finally {
      setSwitching({ active: false });
      setImporting(false);
    }
  };

  const busy = exporting || importing;

  return (
    <SectionShell title="备份恢复" sub="导出或导入当前 Hermes profile 的完整备份压缩包">
      <div className={s.introCard}>
        <h2 className={s.introTitle}>一键备份当前桌面端内核档案</h2>
        <p className={s.introText}>
          备份包会保存当前 profile 下的配置、密钥、技能、记忆、灵魂和会话历史。导入时不会覆盖现有档案，
          而是恢复成一个新的 profile 并自动切换过去。
        </p>
      </div>

      <div className={s.notice}>
        <AlertTriangle size={14} /> 备份 zip 可能包含 <code>.env</code>、OAuth token、API Key 和聊天历史。请只保存在可信位置，不要直接发给他人。
      </div>

      <div className={s.actions}>
        <button type="button" className={settings.btnPrimary} onClick={exportBackup} disabled={busy}>
          <Download size={13} />
          {exporting ? "导出中…" : "导出当前档案备份"}
        </button>
        <button type="button" className={settings.btn} onClick={importBackup} disabled={busy}>
          <Upload size={13} />
          {importing ? "导入中…" : "导入备份压缩包"}
        </button>
      </div>

      {message && <div className={lastExport?.ok || lastImport?.ok ? s.success : s.notice}>{message}</div>}
      {error && <div className={s.error}>{error}</div>}

      <section className={s.previewPanel}>
        <h3 className={s.previewTitle}>
          <Archive size={15} /> 备份策略
        </h3>
        <div className={s.entryList}>
          <div className={s.entryItem}>
            <span>导出范围</span>
            <span className={s.entryMeta}>当前 profile</span>
          </div>
          <div className={s.entryItem}>
            <span>包含内容</span>
            <span className={s.entryMeta}>配置 / 密钥 / 技能 / 记忆 / 灵魂 / 会话</span>
          </div>
          <div className={s.entryItem}>
            <span>导入方式</span>
            <span className={s.entryMeta}>恢复到新 profile 并切换</span>
          </div>
        </div>
      </section>

      {lastExport?.ok && (
        <section className={s.previewPanel}>
          <h3 className={s.previewTitle}>
            <CheckCircle2 size={15} /> 导出结果
          </h3>
          <div className={s.entryList}>
            <div className={s.entryItem}>
              <span>备份文件</span>
              <span className={s.entryMeta}>{lastExport.backupPath}</span>
            </div>
            <div className={s.entryItem}>
              <span>文件数量</span>
              <span className={s.entryMeta}>{lastExport.fileCount.toLocaleString()} 个</span>
            </div>
            <div className={s.entryItem}>
              <span>原始数据量</span>
              <span className={s.entryMeta}>{formatBytes(lastExport.totalBytes)}</span>
            </div>
          </div>
          {lastExport.warnings.length > 0 && (
            <ul className={s.warningList}>
              {lastExport.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}
          <div className={s.actions}>
            <button
              type="button"
              className={settings.btn}
              onClick={() => void openBackupDirectory(lastExport.backupPath)}
              disabled={!lastExport.backupPath || !window.hermesDesktop?.openWorkspacePath}
            >
              <FolderOpen size={13} />
              打开所在文件夹
            </button>
          </div>
        </section>
      )}

      {lastImport?.ok && (
        <section className={s.previewPanel}>
          <h3 className={s.previewTitle}>
            <CheckCircle2 size={15} /> 导入结果
          </h3>
          <div className={s.entryList}>
            <div className={s.entryItem}>
              <span>恢复到 profile</span>
              <span className={s.entryMeta}>{lastImport.targetProfileName}</span>
            </div>
            <div className={s.entryItem}>
              <span>导入文件</span>
              <span className={s.entryMeta}>{lastImport.fileCount.toLocaleString()} 个 · {formatBytes(lastImport.totalBytes)}</span>
            </div>
            <div className={s.entryItem}>
              <span>顶层内容</span>
              <span className={s.entryMeta}>{lastImport.importedEntries.join("、") || "—"}</span>
            </div>
          </div>
          {lastImport.warnings.length > 0 && (
            <ul className={s.warningList}>
              {lastImport.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}
        </section>
      )}
    </SectionShell>
  );
}
