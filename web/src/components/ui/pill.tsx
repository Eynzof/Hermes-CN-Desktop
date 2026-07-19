import type { ReactNode } from "react";
import { Badge, StatusDot } from "@hermes/shared-ui";

export type PillTone = "ok" | "warn" | "err" | "neutral";
export type DotTone = "ok" | "warn" | "err" | "live" | "neutral";

interface PillProps {
  tone?: PillTone;
  children: ReactNode;
  className?: string;
}

export function Pill({ tone = "neutral", children, className }: PillProps) {
  return (
    <Badge tone={tone} className={className}>
      {children}
    </Badge>
  );
}

interface DotProps {
  tone?: DotTone;
  className?: string;
}

export function Dot({ tone = "neutral", className }: DotProps) {
  return <StatusDot tone={tone} className={className} />;
}
