import { useAtom, useAtomValue } from "jotai";
import { useSearchParams } from "react-router-dom";
import {
  FileText,
  GitPullRequest,
  Globe,
  Package,
  X,
} from "lucide-react";
import {
  PREVIEW_PANEL_QUERY_KEY,
  UNSAVED_DISCARD_CONFIRM,
  normalizePreviewPanel,
  type PreviewPanel,
} from "@/lib/preview-rail";
import {
  EMPTY_PREVIEW_RAIL_SELECTION,
  previewEditorDirtyAtom,
  previewRailSelectionMapAtom,
  type PreviewRailSelection,
} from "@/stores/preview-rail";
import { WebPreviewTab } from "./web-preview-tab";
import { FilePreviewTab } from "./file-preview-tab";
import { ReviewTab } from "./review-tab";
import { PanelResizeHandle, usePanelWidth } from "../panel-resize";
import { runtime } from "@/lib/runtime";
import s from "./preview-rail.module.css";

interface PreviewRailProps {
  /** Resolved session id; scopes the per-session selection. */
  sessionId: string;
  /** Session workspace root for file reads (may be empty). */
  workspaceRoot: string;
  onClose: () => void;
}

const TABS: Array<{ key: PreviewPanel; label: string; icon: typeof Globe }> = [
  { key: "files", label: "文件", icon: FileText },
  { key: "review", label: "变更", icon: GitPullRequest },
  { key: "web", label: "浏览器", icon: Globe },
];

// 产物收集依赖后端能力（ redesign P2 ），先以禁用占位形式出现在首位，
// 让布局对齐目标形态。
const PENDING_TABS: Array<{ key: string; label: string; icon: typeof Globe }> = [
  { key: "artifacts", label: "产物", icon: Package },
];

export function PreviewRail({ sessionId, workspaceRoot, onClose }: PreviewRailProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const active = normalizePreviewPanel(searchParams.get(PREVIEW_PANEL_QUERY_KEY));
  const editorDirty = useAtomValue(previewEditorDirtyAtom);
  const remote = runtime.isRemote();
  const localOnlyPanel = active === "files" || active === "review";

  const setActive = (panel: PreviewPanel) => {
    if (panel === active) return;
    // Leaving 文件 unmounts FilePreviewTab and drops any unsaved draft —
    // confirm first instead of losing it silently.
    if (active === "files" && editorDirty && !window.confirm(UNSAVED_DISCARD_CONFIRM)) return;
    const next = new URLSearchParams(searchParams);
    next.set(PREVIEW_PANEL_QUERY_KEY, panel);
    setSearchParams(next, { replace: true });
  };
  const [selectionMap, setSelectionMap] = useAtom(previewRailSelectionMapAtom);
  const selection = selectionMap[sessionId] ?? EMPTY_PREVIEW_RAIL_SELECTION;
  const patchSelection = (patch: Partial<PreviewRailSelection>) => {
    setSelectionMap((map) => ({
      ...map,
      [sessionId]: { ...(map[sessionId] ?? EMPTY_PREVIEW_RAIL_SELECTION), ...patch },
    }));
  };

  const { width, onResizeStart } = usePanelWidth(460, 360, 840);

  return (
    <aside className={s.panel} aria-label="预览面板" style={{ width, flexBasis: width }}>
      <PanelResizeHandle ariaLabel="调整预览面板宽度" onPointerDown={onResizeStart} />
      <header className={s.header}>
        <div className={s.tabs} role="tablist">
          {PENDING_TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              className={s.tab}
              disabled
              title="产物收集依赖后端能力，后续版本提供"
            >
              <Icon size={13} aria-hidden />
              {label}
            </button>
          ))}
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active === key}
              className={s.tab}
              data-active={active === key ? "true" : undefined}
              disabled={remote && (key === "files" || key === "review")}
              title={remote && (key === "files" || key === "review") ? "远端模式下禁用桌面端本机文件能力" : undefined}
              onClick={() => setActive(key)}
            >
              <Icon size={13} aria-hidden />
              {label}
              {key === "files" && editorDirty ? (
                <span className={s.tabDirtyDot} aria-label="有未保存的修改" title="有未保存的修改" />
              ) : null}
            </button>
          ))}
        </div>
        <button className={s.close} type="button" onClick={onClose} aria-label="关闭预览面板">
          <X size={14} aria-hidden />
        </button>
      </header>

      <div className={s.body}>
        {remote && localOnlyPanel ? <div className={s.notice}>远端 Hermes 模式下不会读取或操作桌面端本机的文件与 Git 仓库。</div> : null}
        {!localOnlyPanel && active === "web" ? (
          <WebPreviewTab url={selection.webUrl} onUrlChange={(url) => patchSelection({ webUrl: url })} />
        ) : null}
        {!remote && active === "files" ? (
          <FilePreviewTab
            workspaceRoot={workspaceRoot}
            filePath={selection.filePath}
            onSelectFile={(path) => patchSelection({ filePath: path })}
          />
        ) : null}
        {!remote && active === "review" ? (
          <ReviewTab workspaceRoot={workspaceRoot} active={active === "review"} />
        ) : null}
      </div>
    </aside>
  );
}
