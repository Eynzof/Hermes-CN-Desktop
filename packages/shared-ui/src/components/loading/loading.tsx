import { type ReactNode } from "react";
import { cn } from "../../utils/cn";
import s from "./loading.module.css";

export type LoadingIndicatorSize = "xs" | "sm" | "md" | "lg";
export type LoadingStateVariant = "inline" | "block" | "page";

export interface LoadingIndicatorProps {
  size?: LoadingIndicatorSize;
  className?: string;
}

export function LoadingIndicator({ size = "sm", className }: LoadingIndicatorProps) {
  return (
    <svg
      className={cn(s.indicator, className)}
      data-size={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 6V3" />
      <path d="m16.25 7.75 2.15-2.15" />
      <path d="M18 12h3" />
      <path d="m16.25 16.25 2.15 2.15" />
      <path d="M12 18v3" />
      <path d="m7.75 16.25-2.15 2.15" />
      <path d="M6 12H3" />
      <path d="m7.75 7.75-2.15-2.15" />
    </svg>
  );
}

export interface LoadingStateProps {
  label?: ReactNode;
  description?: ReactNode;
  variant?: LoadingStateVariant;
  size?: LoadingIndicatorSize;
  className?: string;
}

const DEFAULT_SIZE: Record<LoadingStateVariant, LoadingIndicatorSize> = {
  inline: "xs",
  block: "sm",
  page: "md",
};

export function LoadingState({
  label = "加载中…",
  description,
  variant = "block",
  size,
  className,
}: LoadingStateProps) {
  return (
    <div
      className={cn(s.state, className)}
      data-variant={variant}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <LoadingIndicator size={size ?? DEFAULT_SIZE[variant]} />
      <div className={s.copy}>
        <span className={s.label}>{label}</span>
        {description ? <span className={s.description}>{description}</span> : null}
      </div>
    </div>
  );
}
