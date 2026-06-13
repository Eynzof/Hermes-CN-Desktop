import { Popover } from "@hermes/shared-ui";
import { Archive, Edit3, Pin, PinOff, Trash2 } from "lucide-react";
import s from "./session-actions.module.css";

export interface SessionRowMenuProps {
  pinned: boolean;
  disabled?: boolean;
  onTogglePin: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

/**
 * Dropdown body for a single session's actions (pin / rename / archive /
 * delete). Render it inside a `Popover.Root` whose `Popover.Trigger` is the
 * "⋯" button — shared by the history list and the workbench sidebar.
 */
export function SessionRowMenu({
  pinned,
  disabled,
  onTogglePin,
  onRename,
  onArchive,
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
            {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            {pinned ? "取消置顶" : "置顶"}
          </button>
        </Popover.Close>
        <Popover.Close asChild>
          <button type="button" onClick={onRename} role="menuitem" disabled={disabled}>
            <Edit3 size={13} /> 重命名
          </button>
        </Popover.Close>
        <Popover.Close asChild>
          <button type="button" onClick={onArchive} role="menuitem" disabled={disabled}>
            <Archive size={13} /> 归档
          </button>
        </Popover.Close>
        <Popover.Close asChild>
          <button
            type="button"
            onClick={onDelete}
            role="menuitem"
            data-tone="danger"
            disabled={disabled}
          >
            <Trash2 size={13} /> 删除
          </button>
        </Popover.Close>
      </Popover.Content>
    </Popover.Portal>
  );
}
