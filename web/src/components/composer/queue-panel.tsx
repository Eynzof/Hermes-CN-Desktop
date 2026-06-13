import { useState } from "react";
import { ChevronDown, Clock, Paperclip, Pencil, SendHorizontal, Trash2 } from "lucide-react";
import type { QueuedPromptEntry } from "@/stores/composer-queue";
import s from "./queue-panel.module.css";

interface QueuePanelProps {
  entries: QueuedPromptEntry[];
  busy: boolean;
  editingId: string | null;
  onSendNow: (id: string) => void;
  onEdit: (entry: QueuedPromptEntry) => void;
  onDelete: (id: string) => void;
}

function previewText(entry: QueuedPromptEntry): string {
  const text = entry.text.trim();
  if (text) return text;
  return entry.attachments.length > 0 ? "仅附件" : "空消息";
}

/** Compact list of prompts queued while the agent is busy. */
export function QueuePanel({ entries, busy, editingId, onSendNow, onEdit, onDelete }: QueuePanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  if (entries.length === 0) return null;

  return (
    <div className={s.panel}>
      <button
        type="button"
        className={s.head}
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <Clock aria-hidden="true" />
        <span className={s.headLabel}>已排队 {entries.length} 条</span>
        <ChevronDown className={s.chevron} data-collapsed={collapsed || undefined} aria-hidden="true" />
      </button>
      {!collapsed ? (
        <ul className={s.list}>
          {entries.map((entry) => (
            <li key={entry.id} className={s.row} data-editing={entry.id === editingId || undefined}>
              <span className={s.preview} title={entry.text}>
                {previewText(entry)}
              </span>
              {entry.attachments.length > 0 ? (
                <span className={s.badge}>
                  <Paperclip aria-hidden="true" />
                  {entry.attachments.length}
                </span>
              ) : null}
              <span className={s.rowActions}>
                <button
                  type="button"
                  className={s.action}
                  onClick={() => onEdit(entry)}
                  title="编辑"
                  aria-label="编辑此排队消息"
                >
                  <Pencil aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={s.action}
                  onClick={() => onSendNow(entry.id)}
                  disabled={busy}
                  title={busy ? "请等待当前回合结束" : "立即发送"}
                  aria-label="立即发送此排队消息"
                >
                  <SendHorizontal aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={s.action}
                  data-danger="true"
                  onClick={() => onDelete(entry.id)}
                  title="删除"
                  aria-label="删除此排队消息"
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
