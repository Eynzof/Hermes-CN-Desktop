import { Dialog } from "@hermes/shared-ui";
import s from "./session-actions.module.css";

const EXPORT_ERROR_ID = "session-export-error";

export interface SessionExportErrorModalProps {
  error: string;
  onClose: () => void;
}

export function SessionExportErrorModal({ error, onClose }: SessionExportErrorModalProps) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.modalBackdrop} />
        <Dialog.Content className={s.renameModal} aria-describedby={EXPORT_ERROR_ID}>
          <Dialog.Title asChild>
            <h2>导出会话失败</h2>
          </Dialog.Title>
          <div id={EXPORT_ERROR_ID} className={s.renameError}>
            {error}
          </div>
          <div className={s.renameActions}>
            <Dialog.Close asChild>
              <button type="button" className={s.renameSubmit}>
                知道了
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
