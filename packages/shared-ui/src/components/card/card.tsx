import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../utils/cn";
import s from "./card.module.css";

export type CardVariant = "surface" | "subtle" | "flat";
export type CardPadding = "sm" | "md" | "lg";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  variant?: CardVariant;
  padding?: CardPadding;
  interactive?: boolean;
  children?: ReactNode;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    className,
    title,
    description,
    actions,
    footer,
    variant = "surface",
    padding = "md",
    interactive = false,
    children,
    ...props
  },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      className={cn(s.card, className)}
      data-variant={variant}
      data-padding={padding}
      data-interactive={interactive ? "true" : undefined}
    >
      {title || description || actions ? (
        <CardHeader actions={actions}>
          {title ? <CardTitle>{title}</CardTitle> : null}
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      {children ? <CardBody>{children}</CardBody> : null}
      {footer ? <CardFooter>{footer}</CardFooter> : null}
    </div>
  );
});

export interface CardHeaderProps extends HTMLAttributes<HTMLDivElement> {
  actions?: ReactNode;
}

export const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(function CardHeader(
  { className, actions, children, ...props },
  ref,
) {
  return (
    <div {...props} ref={ref} className={cn(s.header, className)}>
      <div className={s.heading}>{children}</div>
      {actions ? <div className={s.actions}>{actions}</div> : null}
    </div>
  );
});

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function CardTitle({ className, ...props }, ref) {
    return <h2 {...props} ref={ref} className={cn(s.title, className)} />;
  },
);

export const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  function CardDescription({ className, ...props }, ref) {
    return <p {...props} ref={ref} className={cn(s.description, className)} />;
  },
);

export const CardBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardBody({ className, ...props }, ref) {
    return <div {...props} ref={ref} className={cn(s.body, className)} />;
  },
);

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardFooter({ className, ...props }, ref) {
    return <div {...props} ref={ref} className={cn(s.footer, className)} />;
  },
);
