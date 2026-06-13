import { useEffect, useMemo, useState } from "react";
import { ChevronUp, File as FileIcon, Folder, RefreshCw } from "lucide-react";
import { useFsList } from "@/hooks/use-fs-list";
import type { FilePreview } from "@/lib/runtime";
import {
  detectLanguage,
  fileExtension,
  formatBytes,
  isMarkdownPath,
  toFencedMarkdown,
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
  const canGoUp = Boolean(dir && workspaceRoot && dir !== workspaceRoot && list.data?.parent);

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
        <p>本会话还没有绑定工作区，无法浏览文件。</p>
      </div>
    );
  }

  return (
    <>
      <div className={s.fileBrowser}>
        <div className={s.crumb}>{dir}</div>
        {canGoUp ? (
          <button
            type="button"
            className={s.fileEntry}
            onClick={() => list.data?.parent && setDir(list.data.parent)}
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
        {!list.isLoading && entries.length === 0 ? <div className={s.crumb}>空目录</div> : null}
      </div>

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
    </>
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
  if (isMarkdownPath(path)) {
    return <MarkdownText text={text} />;
  }
  return <MarkdownText text={toFencedMarkdown(text, detectLanguage(path) ?? fileExtension(path))} />;
}
