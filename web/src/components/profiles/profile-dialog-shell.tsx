import type { ReactNode } from "react";
import { Dialog } from "@hermes/shared-ui";
import { X } from "lucide-react";
import s from "./profiles.module.css";

export interface ProfileDialogShellProps {
  open: boolean;
  title: ReactNode;
  /** 副标题（通常是档案名，monospace 弱化展示）。 */
  titleSub?: ReactNode;
  /** 进行中：禁止 Esc / 点遮罩关闭，避免请求途中丢状态。 */
  busy?: boolean;
  onClose: () => void;
  footer?: ReactNode;
  /** footer 两端对齐（左侧放次要动作如「AI 自动生成」）。 */
  footerSpread?: boolean;
  describedById?: string;
  children: ReactNode;
}

/**
 * 档案各对话框（创建 / 重命名 / 改模型 / 改描述 / 编辑 SOUL / 删除）共用的弹窗外壳，
 * 复用 shared-ui 的 Radix Dialog，行为对齐 session-rename/delete modal。
 */
export function ProfileDialogShell({
  open,
  title,
  titleSub,
  busy = false,
  onClose,
  footer,
  footerSpread = false,
  describedById,
  children,
}: ProfileDialogShellProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content
          className={s.dialog}
          aria-describedby={describedById}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <div className={s.dialogHead}>
            <Dialog.Title asChild>
              <h2 className={s.dialogTitle}>
                {title}
                {titleSub ? <span className={s.titleSub}>· {titleSub}</span> : null}
              </h2>
            </Dialog.Title>
            <button
              type="button"
              className={s.dialogClose}
              onClick={onClose}
              disabled={busy}
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </div>
          <div className={s.dialogBody}>{children}</div>
          {footer ? (
            <div className={footerSpread ? `${s.dialogFoot} ${s.dialogFootSpread}` : s.dialogFoot}>
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
