// ─────────────────────────────────────────────────────────────────────────────
// components/wander-memory/layout.tsx — route-level layout for the MemOS
// (WanderMemory) surface. Wraps SectionShell (global Hermes theme — no dark
// enclave) and applies the `data-wander-memory` scoping attribute. Also
// exports PageGrid (the two-column layout Memories/Dialogue/Files share) and
// WanderMemorySection (sub-heading wrapper for in-route sections).
// ─────────────────────────────────────────────────────────────────────────────

import type { ReactNode } from "react";
import { cn } from "@hermes/shared-ui";
import { SectionShell } from "@/routes/section-shell";
import s from "./layout.module.css";

export interface WanderMemoryLayoutProps {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}

export function WanderMemoryLayout({
  title = "记忆工作台",
  sub = "MemOS Workbench",
  right,
  children,
}: WanderMemoryLayoutProps) {
  return (
    <div data-wander-memory="true" className={s.root}>
      <SectionShell title={title} sub={sub} right={right}>
        {children}
      </SectionShell>
    </div>
  );
}

export interface PageGridProps {
  className?: string;
  children: ReactNode;
}

/** Two-column route grid (main + 360px aside); collapses below 900px. */
export function PageGrid({ className, children }: PageGridProps) {
  return <div className={cn(s.pageGrid, className)}>{children}</div>;
}

export interface WanderMemorySectionProps {
  title: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}

/** Thin sub-heading wrapper for sections inside a wander-memory route. */
export function WanderMemorySection({ title, hint, children }: WanderMemorySectionProps) {
  return (
    <section className={s.section}>
      <div className={s.sectionHead}>
        <h2 className={s.sectionTitle}>{title}</h2>
        {hint ? <span className={s.sectionHint}>{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}
