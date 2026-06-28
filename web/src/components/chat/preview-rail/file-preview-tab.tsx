import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronUp, File as FileIcon, Folder, RefreshCw } from "lucide-react";
import { useFsList } from "@/hooks/use-fs-list";
import type { FilePreview } from "@/lib/runtime";
import {
  buildBreadcrumbs,
  formatBytes,
  fsListErrorText,
  isMarkdownPath,
  parentDir,
} from "@/lib/preview-rail";
import { MarkdownText } from "@/components/chat/markdown-renderer";
import s from "./preview-rail.module.css";

interface FilePreviewTabProps {
  workspaceRoot: string;
  filePath: string | null;
  onSelectFile: (path: string | null) => void;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

// Debounced read so a burst of native file-change events (the upstream uses a
// 200ms FILE_RELOAD_DEBOUNCE_MS) collapses into one re-read.
const RELOAD_DEBOUNCE_MS = 200;

// Draggable split between the directory browser and the file content.
const BROWSER_DEFAULT_HEIGHT = 200;
const BROWSER_MIN_HEIGHT = 72;
const BROWSER_MIN_BOTTOM = 120;
const SPLITTER_HEIGHT = 7;

export function FilePreviewTab({ workspaceRoot, filePath, onSelectFile }: FilePreviewTabProps) {
  const [dir, setDir] = useState(workspaceRoot);

  // Reset the browser to the workspace root whenever the session's workspace changes.
  useEffect(() => {
    setDir(workspaceRoot);
  }, [workspaceRoot]);

  const list = useFsList(dir, { enabled: Boolean(dir) });
  const entries = useMemo(() => {
    const items = list.data?.entries ?? [];
    return [...items].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [list.data?.entries]);
  // Derive the parent client-side: `/api/fs/list` no longer returns `parent`.
  const parent = useMemo(() => parentDir(dir), [dir]);
  const canGoUp = Boolean(dir && workspaceRoot && dir !== workspaceRoot && parent);
  const crumbs = useMemo(() => buildBreadcrumbs(dir), [dir]);

  // Draggable split between the directory browser (top) and the content (below).
  const layoutRef = useRef<HTMLDivElement>(null);
  const [browserHeight, setBrowserHeight] = useState(BROWSER_DEFAULT_HEIGHT);
  const onSplitterDown = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault();
      const layout = layoutRef.current;
      if (!layout) return;
      const layoutHeight = layout.getBoundingClientRect().height;
      const startY = event.clientY;
      const startHeight = browserHeight;

      const onMove = (move: PointerEvent) => {
        const maxTop = layoutHeight - BROWSER_MIN_BOTTOM - SPLITTER_HEIGHT;
        const next = Math.max(
          BROWSER_MIN_HEIGHT,
          Math.min(startHeight + (move.clientY - startY), maxTop),
        );
        setBrowserHeight(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [browserHeight],
  );

  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!filePath || !workspaceRoot) {
      setPreview(null);
      setLoadError(null);
      return;
    }

    let cancelled = false;
    let watchId: string | null = null;
    let debounce: number | null = null;

    const read = () => {
      const bridge = window.hermesDesktop;
      if (!bridge?.readWorkspaceFile) {
        setLoadError("文件预览需要在桌面端中使用。");
        return;
      }
      setLoading(true);
      bridge
        .readWorkspaceFile({ path: filePath, root: workspaceRoot })
        .then((res) => {
          if (cancelled) return;
          setPreview(res);
          setLoadError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setPreview(null);
          setLoadError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    read();

    // Live watch: re-read (debounced) on every change to the selected file.
    void window.hermesDesktop?.watchPreviewFile?.({ path: filePath })
      .then((res) => {
        if (cancelled) {
          void window.hermesDesktop?.stopPreviewFileWatch?.({ watchId: res.watchId });
          return;
        }
        watchId = res.watchId;
      })
      .catch(() => {});

    const unsubscribe = window.hermesDesktop?.onPreviewFileChanged?.((payload) => {
      if (payload.path !== filePath && payload.watchId !== watchId) return;
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(read, RELOAD_DEBOUNCE_MS);
    });

    return () => {
      cancelled = true;
      if (debounce !== null) window.clearTimeout(debounce);
      unsubscribe?.();
      if (watchId) void window.hermesDesktop?.stopPreviewFileWatch?.({ watchId });
    };
  }, [filePath, workspaceRoot]);

  if (!workspaceRoot) {
    return (
      <div className={s.empty}>
        <Folder size={24} aria-hidden />
        <p>本会话还没有关联工作区，无法浏览文件。</p>
      </div>
    );
  }

  return (
    <div className={s.fileLayout} ref={layoutRef}>
      <div className={s.fileBrowser} style={{ height: browserHeight }}>
        <nav className={s.breadcrumb} aria-label="目录路径">
          {crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1;
            const showSep = index > 0 && crumbs[index - 1]?.path !== "/";
            return (
              <Fragment key={crumb.path}>
                {showSep ? <span className={s.crumbSep}>/</span> : null}
                {isLast ? (
                  <span className={s.crumbCurrent}>{crumb.label}</span>
                ) : (
                  <button
                    type="button"
                    className={s.crumbItem}
                    onClick={() => setDir(crumb.path)}
                    title={crumb.path}
                  >
                    {crumb.label}
                  </button>
                )}
              </Fragment>
            );
          })}
        </nav>
        {canGoUp ? (
          <button
            type="button"
            className={s.fileEntry}
            onClick={() => parent && setDir(parent)}
          >
            <ChevronUp size={14} className={s.fileEntryIcon} aria-hidden />
            ..
          </button>
        ) : null}
        {list.isLoading ? <div className={s.crumb}>加载目录中…</div> : null}
        {entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className={s.fileEntry}
            data-active={entry.path === filePath ? "true" : undefined}
            onClick={() => (entry.is_dir ? setDir(entry.path) : onSelectFile(entry.path))}
            title={entry.path}
          >
            {entry.is_dir ? (
              <Folder size={14} className={s.fileEntryIcon} aria-hidden />
            ) : (
              <FileIcon size={14} className={s.fileEntryIcon} aria-hidden />
            )}
            {entry.name}
          </button>
        ))}
        {list.isError || list.data?.error ? (
          <div className={s.crumb}>{fsListErrorText(list.data?.error)}</div>
        ) : !list.isLoading && entries.length === 0 ? (
          <div className={s.crumb}>空目录</div>
        ) : null}
      </div>

      <div
        className={s.splitter}
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整目录与内容的高度"
        onPointerDown={onSplitterDown}
      >
        <div className={s.splitterGrip} />
      </div>

      <div className={s.fileLower}>
        {filePath ? (
          <>
            <div className={s.fileMeta}>
              <span className={s.fileMetaName} title={filePath}>
                {basename(filePath)}
              </span>
              {preview ? <span>{formatBytes(preview.byteSize)}</span> : null}
              {preview?.truncated ? <span>· 已截断预览</span> : null}
              {loading ? <RefreshCw size={12} aria-hidden /> : null}
            </div>
            <div className={s.fileContent}>
              <FileContent path={filePath} preview={preview} error={loadError} loading={loading} />
            </div>
          </>
        ) : (
          <div className={s.empty}>
            <FileIcon size={24} aria-hidden />
            <p>从上方选择一个文件预览。修改磁盘上的文件后，这里会自动刷新。</p>
          </div>
        )}
      </div>
    </div>
  );
}

function FileContent({
  path,
  preview,
  error,
  loading,
}: {
  path: string;
  preview: FilePreview | null;
  error: string | null;
  loading: boolean;
}) {
  if (error) return <div className={s.notice}>读取失败：{error}</div>;
  if (!preview) return <div className={s.notice}>{loading ? "读取中…" : "暂无内容"}</div>;

  if (preview.dataUrl) {
    return <img className={s.fileImage} src={preview.dataUrl} alt={basename(path)} />;
  }
  if (preview.binary) {
    return <div className={s.notice}>二进制文件（{formatBytes(preview.byteSize)}），暂不支持预览。</div>;
  }
  const text = preview.text ?? "";
  if (text.length === 0) {
    return <div className={s.notice}>空文件。</div>;
  }
  // Markdown renders formatted; everything else shows raw source in a plain,
  // reliable <pre>. Routing arbitrary source through the heavyweight markdown
  // pipeline (Streamdown + math + mermaid) was fragile/slow and could render
  // blank — a plain <pre> always shows the content. Mirrors the upstream
  // source view.
  if (isMarkdownPath(path)) {
    return (
      <div className={s.markdownView}>
        <MarkdownText text={text} />
      </div>
    );
  }
  return <pre className={s.codePre}>{text}</pre>;
}
