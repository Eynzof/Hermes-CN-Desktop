import { DropdownMenu } from "@hermes/shared-ui";
import { Archive, ArchiveRestore, Edit3, Pin, PinOff, Trash2 } from "lucide-react";
import s from "./session-actions.module.css";

export interface SessionRowMenuProps {
  pinned: boolean;
  disabled?: boolean;
  /** When true, the row is archived: show "取消归档" wired to onUnarchive. */
  archived?: boolean;
  onTogglePin: () => void;
  onRename: () => void;
  onArchive: () => void;
  /** Restore an archived session. Required when `archived` is true. */
  onUnarchive?: () => void;
  onDelete: () => void;
}

/**
 * Dropdown body for a single session's actions (pin / rename / archive /
 * delete). Render it inside a `DropdownMenu.Root` whose `DropdownMenu.Trigger` is the
 * "⋯" button — shared by the history list and the workbench sidebar. In the
 * history page's archived scope the archive item flips to "取消归档".
 */
export function SessionRowMenu({
  pinned,
  disabled,
  archived,
  onTogglePin,
  onRename,
  onArchive,
  onUnarchive,
  onDelete,
}: SessionRowMenuProps) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        className={s.rowMenu}
        align="end"
        side="bottom"
        sideOffset={4}
        onClick={(event) => event.stopPropagation()}
      >
        <DropdownMenu.Item asChild onSelect={onTogglePin} disabled={disabled}>
          <button type="button" disabled={disabled}>
            {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            {pinned ? "取消置顶" : "置顶"}
          </button>
        </DropdownMenu.Item>
        <DropdownMenu.Item asChild onSelect={onRename} disabled={disabled}>
          <button type="button" disabled={disabled}>
            <Edit3 size={13} /> 重命名
          </button>
        </DropdownMenu.Item>
        <DropdownMenu.Item
          asChild
          onSelect={archived ? onUnarchive : onArchive}
          disabled={disabled}
        >
          {archived ? (
            <button type="button" disabled={disabled}>
              <ArchiveRestore size={13} /> 取消归档
            </button>
          ) : (
            <button type="button" disabled={disabled}>
              <Archive size={13} /> 归档
            </button>
          )}
        </DropdownMenu.Item>
        <DropdownMenu.Item asChild onSelect={onDelete} disabled={disabled}>
          <button
            type="button"
            data-tone="danger"
            disabled={disabled}
          >
            <Trash2 size={13} /> 删除
          </button>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}
