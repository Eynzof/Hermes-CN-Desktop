import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../utils/cn";
import s from "./button.module.css";

export type ButtonVariant = "solid" | "soft" | "outline" | "ghost" | "plain";
export type ButtonTone = "neutral" | "accent" | "success" | "warning" | "danger";
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "inherit";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  tone?: ButtonTone;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  iconOnly?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    type = "button",
    variant = "outline",
    tone = "neutral",
    size = "md",
    fullWidth = false,
    loading = false,
    iconOnly = false,
    leadingIcon,
    trailingIcon,
    disabled,
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      data-tone={tone}
      data-size={size}
      data-full-width={fullWidth ? "true" : undefined}
      data-icon-only={iconOnly ? "true" : undefined}
      data-loading={loading ? "true" : undefined}
      className={cn(s.button, className)}
    >
      {loading ? <span className={s.spinner} aria-hidden="true" /> : leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, "iconOnly"> {
  "aria-label": string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { children, size = "sm", variant = "ghost", ...props },
  ref,
) {
  return (
    <Button {...props} ref={ref} size={size} variant={variant} iconOnly>
      {children}
    </Button>
  );
});
