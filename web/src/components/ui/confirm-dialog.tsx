import { useEffect, useState, type ReactNode } from "react";
import { Button, Dialog } from "@hermes/shared-ui";
import s from "./confirm-dialog.module.css";

/**
 * 应用内确认 / 输入对话框的请求描述。
 *
 * 替代 `window.confirm` / `window.prompt` —— 浏览器脚本对话框在 Tauri webview
 * 里不可靠（macOS WKWebView 下 confirm 静默返回 false、不弹窗），必须用应用内
 * 弹窗。用法见 `use-confirm.tsx` 的 `useConfirm()`。
 */
export interface ConfirmInputSpec {
  label?: string;
  placeholder?: string;
  initialValue?: string;
}

export interface ConfirmDialogSpec {
  title: string;
  /** 支持任意 ReactNode（纯文本或带 <code> 的说明）。 */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作：确认按钮用 danger 色调。 */
  danger?: boolean;
  /**
   * 设置后进入输入模式（替代 window.prompt）：
   * 确认时以输入值 resolve（string），取消 / 关闭 resolve null。
   */
  input?: ConfirmInputSpec;
}

interface ConfirmDialogProps {
  /** null = 关闭。 */
  spec: ConfirmDialogSpec | null;
  /**
   * 确认：input 模式返回输入字符串，否则 true；
   * 取消 / 遮罩 / Esc：input 模式返回 null，否则 false。
   */
  onResolve: (value: boolean | string | null) => void;
}

/**
 * 由 ConfirmProvider 持有的受控确认弹窗（基于 shared-ui 的 Radix Dialog，
 * 与档案 / MCP 弹窗同款外壳）。组件本身不直接使用，走 `useConfirm()`。
 */
export function ConfirmDialog({ spec, onResolve }: ConfirmDialogProps) {
  const [inputValue, setInputValue] = useState("");

  useEffect(() => {
    if (spec) setInputValue(spec.input?.initialValue ?? "");
  }, [spec]);

  const open = spec !== null;
  const cancelValue = spec?.input ? null : false;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // 用户触发关闭（遮罩点击 / Esc）：resolve 取消值。
        if (!next) onResolve(cancelValue);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog}>
          <div className={s.dialogHead}>
            <Dialog.Title asChild>
              <h2 className={s.dialogTitle}>{spec?.title}</h2>
            </Dialog.Title>
          </div>
          <div className={s.dialogBody}>
            {spec?.body != null && (
              <Dialog.Description asChild>
                <div className={s.dialogMessage}>{spec.body}</div>
              </Dialog.Description>
            )}
            {spec?.input && (
              <label className={s.inputField}>
                {spec.input.label ? <span className={s.inputLabel}>{spec.input.label}</span> : null}
                <input
                  className={s.input}
                  type="text"
                  value={inputValue}
                  placeholder={spec.input.placeholder}
                  onChange={(event) => setInputValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onResolve(inputValue);
                  }}
                  autoFocus
                />
              </label>
            )}
          </div>
          <div className={s.dialogFoot}>
            <Button variant="outline" onClick={() => onResolve(cancelValue)}>
              {spec?.cancelLabel ?? "取消"}
            </Button>
            <Button
              variant="solid"
              tone={spec?.danger ? "danger" : "accent"}
              onClick={() => onResolve(spec?.input ? inputValue : true)}
              autoFocus={!spec?.input}
            >
              {spec?.confirmLabel ?? "确定"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
