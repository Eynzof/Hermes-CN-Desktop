import type { ReactNode } from "react";
import { Copy } from "lucide-react";
import { CopyButton, type CopyButtonProps } from "./copy-button";

export interface DiagnosticCopyButtonProps
  extends Omit<CopyButtonProps, "children" | "variant" | "size" | "leadingIcon"> {
  label?: ReactNode;
}

export function DiagnosticCopyButton({
  label = "复制诊断 JSON",
  ...props
}: DiagnosticCopyButtonProps) {
  return (
    <CopyButton
      {...props}
      variant="outline"
      size="md"
      data-diagnostic-copy="true"
    >
      <Copy size={12} aria-hidden="true" />
      {label}
    </CopyButton>
  );
}
