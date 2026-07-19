import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, type ButtonProps } from "../button";

type CopyButtonState = "idle" | "copied" | "error";
type CopyTextSource = string | (() => string | Promise<string>);

export interface CopyButtonProps extends Omit<ButtonProps, "children" | "onClick"> {
  text: CopyTextSource;
  children: ReactNode;
  copiedLabel?: ReactNode;
  errorLabel?: ReactNode;
  resetMs?: number;
  showStatusIcon?: boolean;
  statusIconSize?: number;
  onCopied?: () => void;
  onCopyError?: (error: unknown) => void;
}

function CheckIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.3 4.4 6.4 11.3 2.7 7.6" />
    </svg>
  );
}

export function CopyButton({
  text,
  children,
  copiedLabel = "已复制",
  errorLabel = "复制失败",
  resetMs = 1600,
  showStatusIcon = true,
  statusIconSize = 13,
  onCopied,
  onCopyError,
  disabled,
  type = "button",
  variant = "plain",
  tone = "neutral",
  size = "inherit",
  ...buttonProps
}: CopyButtonProps) {
  const [state, setState] = useState<CopyButtonState>("idle");
  const resetTimer = useRef<number | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
  }, []);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  const markState = useCallback((nextState: Exclude<CopyButtonState, "idle">) => {
    clearResetTimer();
    setState(nextState);
    resetTimer.current = window.setTimeout(() => {
      setState("idle");
      resetTimer.current = null;
    }, resetMs);
  }, [clearResetTimer, resetMs]);

  const handleCopy = useCallback(async () => {
    try {
      const value = typeof text === "function" ? await text() : text;
      if (!value) throw new Error("empty copy text");
      await navigator.clipboard.writeText(value);
      markState("copied");
      onCopied?.();
    } catch (error) {
      markState("error");
      onCopyError?.(error);
    }
  }, [markState, onCopied, onCopyError, text]);

  const isDisabled = disabled || (typeof text === "string" && text.length === 0);
  const isInteractionLocked = state === "copied";

  return (
    <Button
      {...buttonProps}
      type={type}
      variant={variant}
      tone={tone}
      size={size}
      disabled={isDisabled || isInteractionLocked}
      onClick={handleCopy}
      data-copy-state={state}
      aria-live="polite"
    >
      {state === "copied" ? (
        <>
          {showStatusIcon ? <CheckIcon size={statusIconSize} /> : null}
          {copiedLabel}
        </>
      ) : state === "error" ? (
        errorLabel
      ) : (
        children
      )}
    </Button>
  );
}
