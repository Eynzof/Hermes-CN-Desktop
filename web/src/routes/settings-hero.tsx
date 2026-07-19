import type { ReactNode } from "react";
import { cn } from "@hermes/shared-ui";
import s from "./settings.module.css";

interface SettingsHeroProps {
  icon: ReactNode;
  eyebrow: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  ok?: boolean;
  badge?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function SettingsHero({
  icon,
  eyebrow,
  title,
  description,
  ok = false,
  badge,
  children,
  className,
}: SettingsHeroProps) {
  return (
    <div className={cn(s.aboutHero, className)} data-ok={ok ? "true" : "false"}>
      <div className={s.aboutHeroMark}>{icon}</div>
      <div className={s.aboutHeroBody}>
        <div className={s.aboutEyebrow}>{eyebrow}</div>
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
        {children}
      </div>
      {badge}
    </div>
  );
}
