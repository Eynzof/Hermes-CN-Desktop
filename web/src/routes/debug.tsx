import { useMemo, useState } from "react";
import { Bug, FileArchive, FolderOpen } from "lucide-react";
import { debugBus } from "@/lib/debug-bus";
import { BUILD_COMMIT, BUILD_DATE, DESKTOP_VERSION } from "@/lib/build-info";
import { runtime } from "@/lib/runtime";
import { DebugSection } from "./settings-debug-section";
import { SectionShell } from "./section-shell";
import s from "./settings.module.css";

type ExportState =
  | { tone: "normal" | "error"; message: string }
  | null;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function buildRendererDiagnostics(): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    location: typeof window !== "undefined" ? window.location.href : null,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    platform: runtime.platform,
    hermesRuntime: typeof window !== "undefined" ? window.__HERMES_RUNTIME__ ?? null : null,
    bridge: typeof window !== "undefined" ? {
      windowType: window.hermesDesktop?.windowType ?? null,
      hasExportDebugBundle: Boolean(window.hermesDesktop?.exportDebugBundle),
      hasRequest: Boolean(window.hermesDesktop?.request),
      hasRuntimeInfo: Boolean(window.hermesDesktop?.getRuntimeInfo),
    } : null,
    build: {
      version: DESKTOP_VERSION,
      commit: BUILD_COMMIT,
      date: BUILD_DATE,
    },
    viewport: typeof window !== "undefined" ? {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    } : null,
    debugEntries: debugBus.snapshot().length,
  };
}

export function DebugRoute() {
  const [exporting, setExporting] = useState(false);
  const [exportState, setExportState] = useState<ExportState>(null);
  const canExport = typeof window !== "undefined" && Boolean(window.hermesDesktop?.exportDebugBundle);

  const exportSubText = useMemo(() => {
    if (canExport) {
      return "会打包前端 Debug 快照、桌面 runtime 诊断、已脱敏配置摘要，以及 HERMES_HOME 和 gateway runtime 下的日志文件。导出后会自动打开 zip 所在文件夹。";
    }
    return "当前不是 Tauri 桌面环境，无法直接生成本地 debug zip。";
  }, [canExport]);

  const handleExport = async () => {
    if (!window.hermesDesktop?.exportDebugBundle) return;
    setExporting(true);
    setExportState(null);
    try {
      const result = await window.hermesDesktop.exportDebugBundle({
        frontendDebug: debugBus.snapshot(),
        rendererDiagnostics: buildRendererDiagnostics(),
      });
      const warningText = result.warnings.length > 0 ? `，另有 ${result.warnings.length} 条提示` : "";
      setExportState({
        tone: "normal",
        message: `已导出 ${formatBytes(result.sizeBytes)} 的 debug 包，共 ${result.includedFiles} 个文件${warningText}。Finder / 资源管理器已打开：${result.zipPath}`,
      });
    } catch (err) {
      setExportState({
        tone: "error",
        message: `导出 debug 包失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <SectionShell title="Debug" sub="前端事件、REST / Gateway 失败、Console 错误与异常捕获。">
      <div className={s.aboutHero}>
        <div className={s.aboutHeroMark}><Bug size={24} /></div>
        <div className={s.aboutHeroBody}>
          <div className={s.aboutEyebrow}>Hermes Agent 中文社区桌面版排障包</div>
          <h3>一键导出 debug 包</h3>
          <p>{exportSubText}</p>
          {exportState && (
            <div className={s.runtimeMessage} data-tone={exportState.tone === "error" ? "error" : undefined}>
              {exportState.message}
            </div>
          )}
        </div>
        <div className={s.debugHeroActions}>
          <button className={s.btnPrimary} type="button" onClick={handleExport} disabled={!canExport || exporting}>
            <FileArchive size={13} />
            {exporting ? "导出中…" : "导出 debug 包"}
          </button>
          <span><FolderOpen size={12} /> 导出后自动打开所在文件夹</span>
        </div>
      </div>
      <DebugSection showHeading={false} />
    </SectionShell>
  );
}
