import { type ReactNode } from "react";
import { cn } from "../../utils/cn";
import s from "./field.module.css";

export type FieldOrientation = "vertical" | "horizontal";

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  orientation?: FieldOrientation;
  className?: string;
  children: ReactNode;
}

export function Field({
  label,
  hint,
  error,
  required = false,
  htmlFor,
  orientation = "vertical",
  className,
  children,
}: FieldProps) {
  const invalid = Boolean(error);
  return (
    <div className={cn(s.field, className)} data-orientation={orientation} data-invalid={invalid ? "true" : undefined}>
      {label || hint ? (
        <div className={s.labelGroup}>
          {label ? (
            <label className={s.label} htmlFor={htmlFor}>
              {label}
              {required ? <span className={s.required} aria-hidden="true">*</span> : null}
            </label>
          ) : null}
          {hint ? <div className={s.hint}>{hint}</div> : null}
        </div>
      ) : null}
      <div className={s.control}>
        {children}
        {error ? <div className={s.error}>{error}</div> : null}
      </div>
    </div>
  );
}
