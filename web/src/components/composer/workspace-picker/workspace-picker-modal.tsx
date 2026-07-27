import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ArrowUp, Folder, X } from "lucide-react";
import type { FsEntry } from "@hermes/protocol";
import { Dialog } from "@hermes/shared-ui";
import { useFsList } from "@/hooks/use-fs-list";
import { parentDir } from "@/lib/preview-rail";
import s from "./workspace-picker-modal.module.css";

interface WorkspacePickerModalProps {
  open: boolean;
  initialPath?: string;
  onConfirm(absPath: string): void;
  onCancel(): void;
}

function prettyFsError(err: unknown): string {
  if (!(err instanceof Error)) return "无法读取目录";
  const match = err.message.match(/^HTTP \d+: (.+)$/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && typeof parsed.detail === "string") {
        return parsed.detail;
      }
    } catch {
      // body wasn't JSON; fall through
    }
    return match[1];
  }
  return err.message;
}

function splitBreadcrumb(
  absPath: string,
  home: string,
): Array<{ label: string; path: string }> {
  if (!home) {
    return absPath ? [{ label: absPath, path: absPath }] : [];
  }
  const root = { label: "~", path: home };
  if (!absPath || absPath === home) return [root];
  if (!absPath.startsWith(`${home}/`)) {
    // Path outside home (error case). Keep ~ as a "back to home" anchor so the user can recover.
    return [root, { label: absPath, path: absPath }];
  }
  const rel = absPath.slice(home.length + 1);
  const segments = rel.split("/").filter(Boolean);
  const out = [root];
  let acc = home;
  for (const seg of segments) {
    acc += `/${seg}`;
    out.push({ label: seg, path: acc });
  }
  return out;
}

export function WorkspacePickerModal({
  open,
  initialPath,
  onConfirm,
  onCancel,
}: WorkspacePickerModalProps) {
  const manualInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [currentPath, setCurrentPath] = useState(initialPath?.trim() ?? "");
  const [manualInput, setManualInput] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const query = useFsList(currentPath, { enabled: open });
  const data = query.data;
  const directoryEntries = useMemo<FsEntry[]>(
    () => (data?.entries ?? []).filter((e) => e.is_dir),
    [data],
  );

  const resolvedPath = data?.path ?? currentPath;
  // `/api/fs/list` no longer returns `parent`; derive it from the resolved path.
  const parentPath = parentDir(resolvedPath);
  const [lastKnownHome, setLastKnownHome] = useState("");
  const home = data?.home ?? lastKnownHome;
  const breadcrumb = useMemo(() => splitBreadcrumb(resolvedPath, home), [resolvedPath, home]);

  // After first fetch, normalize state so breadcrumb / footer immediately reflect the resolved abs path.
  useEffect(() => {
    if (data?.path && data.path !== currentPath) {
      setCurrentPath(data.path);
    }
  }, [data?.path, currentPath]);

  // Cache home so we can still render a "back to ~" breadcrumb even when the
  // current query errors out (e.g. user pasted /etc).
  useEffect(() => {
    if (data?.home && data.home !== lastKnownHome) {
      setLastKnownHome(data.home);
    }
  }, [data?.home, lastKnownHome]);

  // Reset selection when directory changes.
  useEffect(() => {
    setSelectedName(null);
  }, [resolvedPath]);

  const navigateTo = useCallback((next: string) => {
    setCurrentPath(next);
  }, []);

  const handleConfirm = useCallback(() => {
    if (!resolvedPath) return;
    onConfirm(resolvedPath);
  }, [onConfirm, resolvedPath]);

  const handleManualSubmit = useCallback(() => {
    const next = manualInput.trim();
    if (!next) return;
    setCurrentPath(next);
    setManualInput("");
  }, [manualInput]);

  const handleManualKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      handleManualSubmit();
    }
  };

  const moveSelection = useCallback((delta: 1 | -1) => {
    if (!directoryEntries.length) return;
    setSelectedName((current) => {
      const idx = current ? directoryEntries.findIndex((e) => e.name === current) : -1;
      const next = idx === -1
        ? (delta === 1 ? 0 : directoryEntries.length - 1)
        : (idx + delta + directoryEntries.length) % directoryEntries.length;
      const target = directoryEntries[next];
      if (target && listRef.current) {
        const el = listRef.current.querySelector<HTMLButtonElement>(
          `[data-entry-name="${CSS.escape(target.name)}"]`,
        );
        el?.scrollIntoView({ block: "nearest" });
      }
      return target?.name ?? null;
    });
  }, [directoryEntries]);

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const focusInsideManualInput = document.activeElement === manualInputRef.current;
    if (event.key === "ArrowDown" && !focusInsideManualInput) {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === "ArrowUp" && !focusInsideManualInput) {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === "Enter" && !focusInsideManualInput) {
      if (selectedName) {
        const target = directoryEntries.find((entry) => entry.name === selectedName);
        if (target) {
          event.preventDefault();
          navigateTo(target.path);
          return;
        }
      }
      event.preventDefault();
      handleConfirm();
    }
  };

  if (!open || typeof document === "undefined") return null;

  const errorText = query.isError ? prettyFsError(query.error) : null;
  const isInitialLoad = query.isPending;

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.wpBackdrop} />
        <Dialog.Content
        className={s.wpModal}
        aria-describedby={undefined}
        onKeyDown={handleDialogKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          manualInputRef.current?.focus();
        }}
      >
        <div className={s.wpTitleBar}>
          <Dialog.Title asChild>
            <h2>选择工作区目录</h2>
          </Dialog.Title>
          <Dialog.Close asChild>
            <button
              type="button"
              className={s.wpClose}
              aria-label="关闭目录选择"
            >
              <X aria-hidden="true" />
            </button>
          </Dialog.Close>
        </div>

        <div className={s.wpManualRow}>
          <input
            ref={manualInputRef}
            type="text"
            className={s.wpManualInput}
            placeholder="粘贴 home 内路径，回车跳转（如 ~/projects/foo）"
            value={manualInput}
            onChange={(event) => setManualInput(event.target.value)}
            onKeyDown={handleManualKey}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className={s.wpManualGo}
            onClick={handleManualSubmit}
            disabled={!manualInput.trim()}
          >
            跳转
          </button>
        </div>

        <div className={s.wpBreadcrumbRow}>
          <button
            type="button"
            className={s.wpUpButton}
            onClick={() => parentPath && navigateTo(parentPath)}
            disabled={!parentPath}
            aria-label="上一级"
            title="上一级"
          >
            <ArrowUp aria-hidden="true" />
          </button>
          <div className={s.wpBreadcrumb}>
            {breadcrumb.map((crumb, idx) => (
              <span key={crumb.path} className={s.wpCrumbWrap}>
                <button
                  type="button"
                  className={s.wpCrumb}
                  data-current={crumb.path === resolvedPath}
                  onClick={() => navigateTo(crumb.path)}
                >
                  {crumb.label}
                </button>
                {idx < breadcrumb.length - 1 ? <span className={s.wpCrumbSep}>/</span> : null}
              </span>
            ))}
          </div>
        </div>

        <div ref={listRef} className={s.wpList}>
          {isInitialLoad ? (
            <div className={s.wpEmpty}>加载中...</div>
          ) : errorText ? (
            <div className={s.wpError}>{errorText}</div>
          ) : directoryEntries.length === 0 ? (
            <div className={s.wpEmpty}>没有子目录</div>
          ) : (
            directoryEntries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className={s.wpEntry}
                data-entry-name={entry.name}
                data-selected={selectedName === entry.name}
                onClick={() => setSelectedName(entry.name)}
                onDoubleClick={() => navigateTo(entry.path)}
              >
                <Folder className={s.wpEntryIcon} aria-hidden="true" />
                <span className={s.wpEntryName}>{entry.name}</span>
              </button>
            ))
          )}
        </div>

        <div className={s.wpFooter}>
          <div className={s.wpFooterPath} title={resolvedPath}>
            {resolvedPath || "—"}
          </div>
          <div className={s.wpFooterButtons}>
            <Dialog.Close asChild>
              <button type="button" className={s.wpButtonGhost}>取消</button>
            </Dialog.Close>
            <button
              type="button"
              className={s.wpButtonPrimary}
              onClick={handleConfirm}
              disabled={!resolvedPath || query.isPending}
            >
              选择此目录
            </button>
          </div>
        </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
