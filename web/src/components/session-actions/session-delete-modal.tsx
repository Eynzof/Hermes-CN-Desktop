import { Dialog } from "@hermes/shared-ui";
import type { SessionSummary } from "@hermes/protocol";
import { sessionDisplayTitle } from "@/lib/session-title";
import s from "./session-actions.module.css";

const DELETE_DESC_ID = "session-delete-confirm-desc";

export interface SessionDeleteModalProps {
  sessions: SessionSummary[];
  deleting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * Confirmation dialog for (bulk) session deletion. Supports a single session or
 * many; shows a capped preview list. Shared by history + workbench sidebar.
 */
export function SessionDeleteModal({
  sessions,
  deleting,
  onClose,
  onConfirm,
}: SessionDeleteModalProps) {
  const count = sessions.length;
  const preview = sessions.slice(0, 5);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !deleting) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={s.modalBackdrop} />
        <Dialog.Content
          className={s.confirmModal}
          aria-describedby={DELETE_DESC_ID}
          onEscapeKeyDown={(event) => {
            if (deleting) event.preventDefault();
          }}
        >
          <Dialog.Title asChild>
            <h2>{count === 1 ? "删除会话" : "批量删除会话"}</h2>
          </Dialog.Title>
          <Dialog.Description id={DELETE_DESC_ID} className={s.confirmText}>
            将删除 {count} 个会话，此操作不可撤销。
          </Dialog.Description>
          <div className={s.confirmList}>
            {preview.map((session) => (
              <div key={session.id} className={s.confirmListItem}>
                {sessionDisplayTitle(session)}
              </div>
            ))}
            {count > preview.length ? (
              <div className={s.confirmListMore}>另有 {count - preview.length} 个会话</div>
            ) : null}
          </div>
          <div className={s.confirmActions}>
            <button type="button" className={s.confirmCancel} onClick={onClose} disabled={deleting}>
              取消
            </button>
            <button type="button" className={s.confirmDanger} onClick={onConfirm} disabled={deleting}>
              {deleting ? "删除中…" : "确认删除"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
