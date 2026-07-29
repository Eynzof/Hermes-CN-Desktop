import { Dialog } from "@hermes/shared-ui";
import s from "./session-actions.module.css";

const BRANCH_ERROR_ID = "session-branch-error";

export interface SessionBranchErrorModalProps {
  error: string;
  onClose: () => void;
}

export function SessionBranchErrorModal({ error, onClose }: SessionBranchErrorModalProps) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.modalBackdrop} />
        <Dialog.Content className={s.renameModal} aria-describedby={BRANCH_ERROR_ID}>
          <Dialog.Title asChild>
            <h2>会话分叉失败</h2>
          </Dialog.Title>
          <div id={BRANCH_ERROR_ID} className={s.renameError}>
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
