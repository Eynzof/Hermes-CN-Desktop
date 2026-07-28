import { Popover } from "@hermes/shared-ui";
import { Archive, ArchiveRestore, Download, Edit3, Pin, PinOff, Trash2 } from "lucide-react";
import s from "./session-actions.module.css";

export interface SessionRowMenuProps {
  pinned: boolean;
  disabled?: boolean;
  /** When true, the row is archived: show "取消归档" wired to onUnarchive. */
  archived?: boolean;
  onTogglePin: () => void;
  onRename: () => void;
  onExport: () => void;
  onArchive: () => void;
  /** Restore an archived session. Required when `archived` is true. */
  onUnarchive?: () => void;
  onDelete: () => void;
}

/**
 * Dropdown body for a single session's actions (pin / rename / export /
 * archive / delete). Render it inside a `Popover.Root` whose `Popover.Trigger` is the
 * "⋯" button — shared by the history list and the workbench sidebar. In the
 * history page's archived scope the archive item flips to "取消归档".
 */
export function SessionRowMenu({
  pinned,
  disabled,
  archived,
  onTogglePin,
  onRename,
  onExport,
  onArchive,
  onUnarchive,
  onDelete,
}: SessionRowMenuProps) {
  return (
    <Popover.Portal>
      <Popover.Content
        className={s.rowMenu}
        align="end"
        side="bottom"
        sideOffset={4}
        role="menu"
        onClick={(event) => event.stopPropagation()}
      >
        <Popover.Close asChild>
          <button type="button" onClick={onTogglePin} role="menuitem" disabled={disabled}>
            {pinned ? <PinOff size={12} /> : <Pin size={12} />}
            {pinned ? "取消置顶" : "置顶"}
          </button>
        </Popover.Close>
        <Popover.Close asChild>
          <button type="button" onClick={onRename} role="menuitem" disabled={disabled}>
            <Edit3 size={12} /> 重命名
          </button>
        </Popover.Close>
        <Popover.Close asChild>
          <button type="button" onClick={onExport} role="menuitem" disabled={disabled}>
            <Download size={13} /> 导出 JSON
          </button>
        </Popover.Close>
        <Popover.Close asChild>
          {archived ? (
            <button type="button" onClick={onUnarchive} role="menuitem" disabled={disabled}>
              <ArchiveRestore size={12} /> 取消归档
            </button>
          ) : (
            <button type="button" onClick={onArchive} role="menuitem" disabled={disabled}>
              <Archive size={12} /> 归档
            </button>
          )}
        </Popover.Close>
        <Popover.Close asChild>
          <button
            type="button"
            onClick={onDelete}
            role="menuitem"
            data-tone="danger"
            disabled={disabled}
          >
            <Trash2 size={12} /> 删除
          </button>
        </Popover.Close>
      </Popover.Content>
    </Popover.Portal>
  );
}
