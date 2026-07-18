import { useState } from "react";
import { atom, useAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import { Users, X } from "lucide-react";
import { useProfiles } from "@/hooks/use-profiles";
import { useGateway } from "@/hooks/use-gateway";
import s from "./create-group-chat-dialog.module.css";

// Group chat (P-048): open state for the "新建群聊" dialog, toggled from the sidebar.
export const groupChatDialogOpenAtom = atom(false);

// A lightweight multi-select dialog for composing a group chat from existing
// profiles. On create it calls groupchat.create (via useGateway), adopts the
// returned room as the active session, and navigates into it.
export function CreateGroupChatDialog() {
  const [open, setOpen] = useAtom(groupChatDialogOpenAtom);
  const { data: profiles } = useProfiles();
  const { createGroupChat } = useGateway();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate = selected.length >= 1 && !creating;

  const toggle = (name: string) =>
    setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));

  const close = () => {
    if (creating) return;
    setOpen(false);
    setSelected([]);
    setTitle("");
    setError(null);
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createGroupChat(selected, title.trim() || undefined);
      setOpen(false);
      setSelected([]);
      setTitle("");
      navigate(`/tasks/${result.room_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  if (!open) return null;

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-label="新建群聊" onClick={close}>
      <div className={s.card} onClick={(e) => e.stopPropagation()}>
        <div className={s.header}>
          <Users size={16} />
          <span className={s.title}>新建群聊</span>
          <button type="button" className={s.closeBtn} onClick={close} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <input
          className={s.nameInput}
          placeholder="群聊名称（可选）"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className={s.hint}>选择参与群聊的助手（Profile），至少 1 个：</div>
        <div className={s.list}>
          {(profiles ?? []).map((p) => {
            const checked = selected.includes(p.name);
            return (
              <label key={p.name} className={s.row} data-selected={checked ? "true" : undefined}>
                <input type="checkbox" checked={checked} onChange={() => toggle(p.name)} />
                <span className={s.rowName}>{p.name}</span>
                {p.description ? <span className={s.rowDesc}>{p.description}</span> : null}
              </label>
            );
          })}
          {profiles && profiles.length === 0 ? (
            <div className={s.empty}>暂无可用 Profile</div>
          ) : null}
        </div>
        {error ? <div className={s.error}>{error}</div> : null}
        <div className={s.actions}>
          <button type="button" className={s.cancelBtn} onClick={close} disabled={creating}>
            取消
          </button>
          <button type="button" className={s.createBtn} onClick={handleCreate} disabled={!canCreate}>
            {creating ? "创建中…" : `创建（${selected.length}）`}
          </button>
        </div>
      </div>
    </div>
  );
}
