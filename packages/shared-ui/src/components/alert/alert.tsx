import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../utils/cn";
import s from "./alert.module.css";

export type AlertTone = "neutral" | "info" | "accent" | "success" | "warning" | "danger" | "ok" | "warn" | "error" | "err";
export type AlertSize = "sm" | "md";
export type AlertLayout = "stack" | "inline";

export interface AlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: AlertTone;
  size?: AlertSize;
  layout?: AlertLayout;
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export const Alert = forwardRef<HTMLDivElement, AlertProps>(function Alert(
  {
    className,
    tone = "neutral",
    size = "md",
    layout = "stack",
    title,
    actions,
    children,
    role,
    ...props
  },
  ref,
) {
  const resolvedRole = role ?? (tone === "danger" || tone === "error" || tone === "err" ? "alert" : "status");
  return (
    <div
      {...props}
      ref={ref}
      role={resolvedRole}
      className={cn(s.alert, className)}
      data-tone={tone}
      data-size={size}
      data-layout={layout}
    >
      <div className={s.body}>
        {title ? <strong className={s.title}>{title}</strong> : null}
        <div className={s.content}>{children}</div>
      </div>
      {actions ? <div className={s.actions}>{actions}</div> : null}
    </div>
  );
});
