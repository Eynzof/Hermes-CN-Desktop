import type { ReactNode } from "react";
import { Dialog } from "@hermes/shared-ui";
import { X } from "lucide-react";
import s from "./mcp.module.css";

export interface McpDialogShellProps {
  open: boolean;
  title: ReactNode;
  /** 进行中：禁止 Esc / 点遮罩关闭，避免请求途中丢状态。 */
  busy?: boolean;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * MCP 各对话框（添加服务 / 安装目录项 / 删除确认）共用的弹窗外壳。
 * 复用 shared-ui 的 Radix Dialog（自带居中面板/遮罩/动效），与档案弹窗一致。
 */
export function McpDialogShell({
  open,
  title,
  busy = false,
  onClose,
  footer,
  children,
}: McpDialogShellProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content
          className={s.dialog}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <div className={s.dialogHead}>
            <Dialog.Title asChild>
              <h2 className={s.dialogTitle}>{title}</h2>
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
          {footer ? <div className={s.dialogFoot}>{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
