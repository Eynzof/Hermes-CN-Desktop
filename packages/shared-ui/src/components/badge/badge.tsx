import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../utils/cn";
import s from "./badge.module.css";

export type StatusTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  /** @deprecated 迁移期兼容旧页面命名，请优先使用 success。 */
  | "ok"
  /** @deprecated 迁移期兼容旧页面命名，请优先使用 warning。 */
  | "warn"
  /** @deprecated 迁移期兼容旧页面命名，请优先使用 danger。 */
  | "err"
  /** 实时状态点专用。 */
  | "live";

export type BadgeTone = Exclude<StatusTone, "live"> | "live";
export type BadgeVariant = "soft" | "outline" | "solid";
export type BadgeSize = "sm" | "md";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  size?: BadgeSize;
  children: ReactNode;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, tone = "neutral", variant = "soft", size = "md", children, ...props },
  ref,
) {
  return (
    <span
      {...props}
      ref={ref}
      className={cn(s.badge, className)}
      data-tone={tone}
      data-variant={variant}
      data-size={size}
    >
      {children}
    </span>
  );
});

export type StatusDotTone = StatusTone;
export type StatusDotSize = "sm" | "md" | "lg";

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusDotTone;
  size?: StatusDotSize;
}

export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(function StatusDot(
  { className, tone = "neutral", size = "md", ...props },
  ref,
) {
  return (
    <span
      {...props}
      ref={ref}
      className={cn(s.dot, className)}
      data-tone={tone}
      data-size={size}
    />
  );
});
