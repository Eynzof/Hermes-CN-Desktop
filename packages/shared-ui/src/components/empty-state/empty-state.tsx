import { type ReactNode } from "react";
import { cn } from "../../utils/cn";
import s from "./empty-state.module.css";

export type EmptyStateVariant = "subtle" | "plain";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  variant?: EmptyStateVariant;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  actions,
  variant = "subtle",
  className,
}: EmptyStateProps) {
  return (
    <div className={cn(s.emptyState, className)} data-variant={variant}>
      {icon ? <div className={s.icon}>{icon}</div> : null}
      <div className={s.body}>
        <div className={s.title}>{title}</div>
        {description ? <div className={s.description}>{description}</div> : null}
      </div>
      {actions ? <div className={s.actions}>{actions}</div> : null}
    </div>
  );
}
