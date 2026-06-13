import { Dialog } from "@hermes/shared-ui";
import s from "./session-actions.module.css";

const RENAME_ERROR_ID = "session-rename-error";

export interface SessionRenameModalProps {
  value: string;
  saving: boolean;
  error: string;
  onChange: (next: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}

/** Modal input for renaming a session. Shared by history + workbench sidebar. */
export function SessionRenameModal({
  value,
  saving,
  error,
  onChange,
  onClose,
  onSubmit,
}: SessionRenameModalProps) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={s.modalBackdrop} />
        <Dialog.Content
          className={s.renameModal}
          aria-describedby={error ? RENAME_ERROR_ID : undefined}
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (saving) event.preventDefault();
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <Dialog.Title asChild>
              <h2>重命名会话</h2>
            </Dialog.Title>
            <input
              className={s.renameInput}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              autoFocus
              maxLength={80}
            />
            {error ? (
              <div id={RENAME_ERROR_ID} className={s.renameError}>
                {error}
              </div>
            ) : null}
            <div className={s.renameActions}>
              <Dialog.Close asChild>
                <button type="button" className={s.renameCancel} disabled={saving}>
                  取消
                </button>
              </Dialog.Close>
              <button type="submit" className={s.renameSubmit} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
