import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronUp, File as FileIcon, Folder, Pencil, RefreshCw } from "lucide-react";
import { useFsList } from "@/hooks/use-fs-list";
import type { FilePreview } from "@/lib/runtime";
import {
  buildBreadcrumbs,
  canEditPreview,
  detectEol,
  formatBytes,
  fsListErrorText,
  isMarkdownPath,
  isStaleOnDisk,
  normalizeEol,
  parentDir,
  restoreEol,
  UNSAVED_DISCARD_CONFIRM,
  type EolStyle,
} from "@/lib/preview-rail";
import { MarkdownText } from "@/components/chat/markdown-renderer";
import { previewEditorDirtyAtom } from "@/stores/preview-rail";
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
  // Switching to another file resets the editor and would silently drop an
  // unsaved draft — confirm first (the atom is written by the editor below).
  const editorDirty = useAtomValue(previewEditorDirtyAtom);

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
  // Bumped after a save / discard so the read effect re-runs immediately,
  // without waiting for the (debounced) native file watcher.
  const [reloadTick, setReloadTick] = useState(0);

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
  }, [filePath, workspaceRoot, reloadTick]);

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
            onClick={() => {
              if (entry.is_dir) {
                setDir(entry.path);
                return;
              }
              if (entry.path === filePath) return;
              if (editorDirty && !window.confirm(UNSAVED_DISCARD_CONFIRM)) return;
              onSelectFile(entry.path);
            }}
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
          <FileViewer
            path={filePath}
            workspaceRoot={workspaceRoot}
            preview={preview}
            error={loadError}
            loading={loading}
            onReload={() => setReloadTick((tick) => tick + 1)}
          />
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

function isTypableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (el as HTMLElement).isContentEditable === true;
}

// Read + in-place edit (spot editor) for the selected file. Ports the upstream
// Electron `LocalFilePreview`: the live draft and the snapshot the user started
// from live in refs so typing never re-renders this component — `dirty` is the
// only render-worthy signal and it flips just once when crossing clean↔dirty.
// The editor is rendered ahead of any background re-read so a watcher tick can't
// unmount it and drop the draft. Saving re-reads the disk first to detect a
// stale-on-disk conflict (an agent / external write) before clobbering.
function FileViewer({
  path,
  workspaceRoot,
  preview,
  error,
  loading,
  onReload,
}: {
  path: string;
  workspaceRoot: string;
  preview: FilePreview | null;
  error: string | null;
  loading: boolean;
  onReload: () => void;
}) {
  const setEditorDirty = useSetAtom(previewEditorDirtyAtom);

  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const draftRef = useRef("");
  const baselineRef = useRef("");
  // EOL style of the baseline. The textarea normalizes CRLF→LF, so saves
  // restore this style to avoid rewriting a CRLF file wholesale to LF.
  const baselineEolRef = useRef<EolStyle>("\n");
  const readViewRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(false);

  // Reset all editor state whenever the previewed file changes.
  useEffect(() => {
    setEditing(false);
    setDirty(false);
    setSaving(false);
    setSaveError(null);
    setConflict(false);
    draftRef.current = "";
    baselineRef.current = "";
    baselineEolRef.current = "\n";
  }, [path]);

  // Editing is only offered for whole, readable text (see `canEditPreview`), and
  // needs the native write bridge (absent in the browser fallback).
  const canEdit =
    canEditPreview(preview) && typeof window.hermesDesktop?.writeWorkspaceFile === "function";

  // Per-keystroke: update the draft ref (no render) and only flip `dirty` when
  // it actually changes, so a long typing run triggers a single re-render. Both
  // sides are LF-normalized so a CRLF baseline never reads as dirty just
  // because the textarea normalized its value.
  const handleChange = useCallback((value: string) => {
    draftRef.current = value;
    const next = normalizeEol(value) !== normalizeEol(baselineRef.current);
    setDirty((prev) => (prev === next ? prev : next));
  }, []);

  // Publish the unsaved state to the rail so the 文件 tab shows a modified dot.
  // Cleared on unmount / file change so a stale dot never lingers.
  useEffect(() => {
    setEditorDirty(editing && dirty);
    return () => setEditorDirty(false);
  }, [editing, dirty, setEditorDirty]);

  const beginEdit = useCallback(() => {
    const text = preview?.text ?? "";
    baselineRef.current = text;
    baselineEolRef.current = detectEol(text);
    draftRef.current = text;
    setDirty(false);
    setEditorKey((key) => key + 1);
    setSaving(false);
    setSaveError(null);
    setConflict(false);
    setEditing(true);
  }, [preview?.text]);

  // Keep the latest beginEdit for the keydown listener so it can stay subscribed
  // across renders without recreating itself or going stale.
  const beginEditRef = useRef(beginEdit);
  beginEditRef.current = beginEdit;

  // Bare `e` enters edit mode when the file pane is hovered or focused and no
  // typable field has focus — mirrors the upstream button-free shortcut.
  useEffect(() => {
    if (!canEdit || editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "e" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypableElement(document.activeElement)) return;
      const root = readViewRef.current;
      const focusWithin = Boolean(
        root && document.activeElement && root.contains(document.activeElement),
      );
      if (!hoverRef.current && !focusWithin) return;
      event.preventDefault();
      beginEditRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canEdit, editing]);

  // Leaving edit mode (Escape / 取消) drops the draft — confirm when dirty.
  const cancelEdit = useCallback(() => {
    if (dirty && !window.confirm(UNSAVED_DISCARD_CONFIRM)) return;
    setEditing(false);
    setSaveError(null);
    setConflict(false);
  }, [dirty]);

  const discardAndReload = useCallback(() => {
    setEditing(false);
    setConflict(false);
    setSaveError(null);
    onReload();
  }, [onReload]);

  const saveEdit = useCallback(
    async (force = false) => {
      const bridge = window.hermesDesktop;
      if (saving || !bridge?.writeWorkspaceFile) return;
      setSaving(true);
      setSaveError(null);
      try {
        // Stale-on-disk guard: re-read what's on disk now and compare to the
        // snapshot the user started from. If something changed underneath (an
        // agent edit, an external save), surface the choice instead of silently
        // clobbering. `force` is the user picking "覆盖保存" from the banner.
        if (!force && bridge.readWorkspaceFile) {
          try {
            const current = await bridge.readWorkspaceFile({ path, root: workspaceRoot });
            if (isStaleOnDisk(current, baselineRef.current)) {
              setConflict(true);
              setSaving(false);
              return;
            }
          } catch {
            // Couldn't re-read for the check — fall through and attempt the write.
          }
        }
        // Restore the baseline's EOL style: the textarea normalized CRLF→LF,
        // and saving must not rewrite the whole file's line endings.
        const content = restoreEol(draftRef.current, baselineEolRef.current);
        await bridge.writeWorkspaceFile({
          path,
          root: workspaceRoot,
          content,
        });
        // The new baseline is what actually landed on disk (EOL restored), so
        // the next stale-on-disk check compares byte-equal text.
        baselineRef.current = content;
        setDirty(false);
        setConflict(false);
        // Stay in edit mode after a successful save (like a real editor); the
        // refreshed baseline keeps the buffer clean until the next keystroke.
        onReload();
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [saving, path, workspaceRoot, onReload],
  );

  return (
    <>
      <div className={s.fileMeta}>
        <span className={s.fileMetaName} title={path}>
          {basename(path)}
        </span>
        {preview ? <span>{formatBytes(preview.byteSize)}</span> : null}
        {preview?.truncated ? <span>· 已截断预览</span> : null}
        {preview?.lossyUtf8 ? <span>· 非 UTF-8 编码，暂不支持就地编辑</span> : null}
        {editing && dirty ? <span className={s.dirtyBadge}>● 未保存</span> : null}
        {loading && !editing ? <RefreshCw size={12} aria-hidden /> : null}
        {editing ? (
          <span className={s.editControls}>
            <button
              type="button"
              className={s.editAction}
              data-variant="primary"
              onClick={() => void saveEdit()}
              disabled={!dirty || saving}
            >
              {saving ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              className={s.editAction}
              onClick={cancelEdit}
              disabled={saving}
            >
              取消
            </button>
          </span>
        ) : canEdit ? (
          <button type="button" className={s.editButton} onClick={beginEdit} title="编辑 (e)">
            <Pencil size={12} aria-hidden />
            编辑
          </button>
        ) : null}
      </div>

      {conflict ? (
        <div className={s.conflictBanner}>
          <div className={s.conflictTitle}>文件已在磁盘上发生变化</div>
          <div className={s.conflictBody}>
            自你开始编辑后，这个文件被改动过（可能是 agent 或外部程序写入）。覆盖保存会丢弃磁盘上的改动。
          </div>
          <div className={s.conflictActions}>
            <button
              type="button"
              className={s.conflictAction}
              onClick={() => void saveEdit(true)}
            >
              覆盖保存
            </button>
            <button type="button" className={s.conflictAction} onClick={discardAndReload}>
              放弃并重新加载
            </button>
          </div>
        </div>
      ) : null}

      {saveError ? <div className={s.saveError}>保存失败：{saveError}</div> : null}

      {editing ? (
        <div className={s.editorWrap}>
          <textarea
            key={editorKey}
            className={s.editor}
            defaultValue={baselineRef.current}
            spellCheck={false}
            autoFocus
            aria-label="文件内容编辑器"
            onChange={(event) => handleChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                event.preventDefault();
                void saveEdit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelEdit();
              }
            }}
          />
        </div>
      ) : (
        <div
          className={s.fileContent}
          ref={readViewRef}
          onMouseEnter={() => {
            hoverRef.current = true;
          }}
          onMouseLeave={() => {
            hoverRef.current = false;
          }}
        >
          <FileContent path={path} preview={preview} error={error} loading={loading} />
        </div>
      )}
    </>
  );
}
