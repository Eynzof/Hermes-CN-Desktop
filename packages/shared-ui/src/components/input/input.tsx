import {
  forwardRef,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "../../utils/cn";
import s from "./input.module.css";

export type ControlSize = "sm" | "md" | "lg";

interface ControlProps {
  controlSize?: ControlSize;
  invalid?: boolean;
  mono?: boolean;
  fullWidth?: boolean;
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">, ControlProps {}

function hasDataMono(props: object): boolean {
  const dataMono = (props as Record<string, unknown>)["data-mono"];
  return dataMono === true || dataMono === "true";
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    className,
    controlSize = "md",
    invalid = false,
    mono = false,
    fullWidth = true,
    ...props
  },
  ref,
) {
  return (
    <input
      {...props}
      ref={ref}
      className={cn(s.control, className)}
      data-size={controlSize}
      data-invalid={invalid ? "true" : undefined}
      data-mono={mono || hasDataMono(props) ? "true" : undefined}
      data-full-width={fullWidth ? undefined : "false"}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, ControlProps {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    className,
    controlSize = "md",
    invalid = false,
    mono = false,
    fullWidth = true,
    ...props
  },
  ref,
) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={cn(s.control, s.textarea, className)}
      data-size={controlSize}
      data-invalid={invalid ? "true" : undefined}
      data-mono={mono || hasDataMono(props) ? "true" : undefined}
      data-full-width={fullWidth ? undefined : "false"}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, ControlProps {}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    className,
    controlSize = "md",
    invalid = false,
    mono = false,
    fullWidth = true,
    children,
    ...props
  },
  ref,
) {
  return (
    <select
      {...props}
      ref={ref}
      className={cn(s.control, s.select, className)}
      data-size={controlSize}
      data-invalid={invalid ? "true" : undefined}
      data-mono={mono || hasDataMono(props) ? "true" : undefined}
      data-full-width={fullWidth ? undefined : "false"}
    >
      {children}
    </select>
  );
});
