import { useMemo, useState } from "react";
import { clsx } from "clsx";
import { formatTokens } from "@/lib/format";
import { contextUsageRisk, type ContextRisk } from "@/lib/context-usage";
import type { ContextUsageViewModel } from "@/hooks/use-context-usage";
import s from "./context-usage-panel.module.css";

interface ContextUsagePanelProps {
  usage: ContextUsageViewModel | null;
  className?: string;
}

function formatTokenCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return formatTokens(value);
}

function ContextGrid({ categories, total }: { categories: ContextUsageViewModel["categories"]; total: number }) {
  const cells = useMemo(() => {
    if (total === 0) return Array<string>(100).fill("·");
    const glyphs = ["■", "▣", "▩", "▤", "▥", "▦", "▧", "▨"];
    const out = Array<string>(100).fill("·");
    const nonEmpty = categories.filter((c) => c.tokens > 0);
    const nonEmptyTotal = nonEmpty.reduce((sum, c) => sum + c.tokens, 0);

    let allocated = 0;
    const allocations: { index: number; count: number; color: string }[] = [];
    for (let i = 0; i < categories.length; i += 1) {
      const cat = categories[i];
      if (cat.tokens <= 0) continue;
      const count = Math.max(1, Math.floor((cat.tokens / nonEmptyTotal) * 100));
      allocations.push({ index: i, count, color: cat.color });
      allocated += count;
    }
    if (allocated > 100) {
      let over = allocated - 100;
      for (let i = allocations.length - 1; i >= 0 && over > 0; i -= 1) {
        const remove = Math.min(allocations[i].count - 1, over);
        allocations[i].count -= remove;
        over -= remove;
        if (allocations[i].count <= 0) allocations.splice(i, 1);
      }
    } else if (allocated < 100 && allocations.length > 0) {
      allocations[0].count += 100 - allocated;
    }

    let cursor = 0;
    for (const { count, index } of allocations) {
      const glyph = glyphs[index % glyphs.length];
      for (let i = 0; i < count && cursor < 100; i += 1) {
        out[cursor] = glyph;
        cursor += 1;
      }
    }
    return out;
  }, [categories, total]);

  return (
    <div className={s.grid} aria-hidden="true">
      {cells.map((cell, index) => (
        <span key={index} className={s.cell}>
          {cell}
        </span>
      ))}
    </div>
  );
}

function CategoryRow({ category, total }: { category: ContextUsageViewModel["categories"][number]; total: number }) {
  const percent = total > 0 ? (category.tokens / total) * 100 : 0;
  return (
    <div className={s.row}>
      <span className={s.swatch} style={{ backgroundColor: category.color }} />
      <span className={s.label}>{category.label}</span>
      <span className={s.tokens}>{formatTokenCount(category.tokens)}</span>
      <span className={s.percent}>{percent.toFixed(1)}%</span>
    </div>
  );
}

export function ContextUsagePanel({ usage, className }: ContextUsagePanelProps) {
  const [showDetails, setShowDetails] = useState(false);

  if (!usage) {
    return (
      <div className={clsx(s.panel, className)}>
        <p className={s.empty}>No context usage data available.</p>
      </div>
    );
  }

  const total = usage.categories.reduce((sum, c) => sum + c.tokens, 0);
  const usedLabel = formatTokenCount(usage.used);
  const maxLabel = formatTokenCount(usage.max);
  const percent = usage.percent ?? 0;
  const risk = contextUsageRisk({ used: usage.used, max: usage.max, percent: usage.percent });

  return (
    <div className={clsx(s.panel, className)} data-risk={risk}>
      <div className={s.header}>
        <span className={s.title}>Context Usage</span>
        {usage.model ? <span className={s.model}>{usage.model}</span> : null}
      </div>

      <div className={s.summary}>
        <div className={s.ringWrap}>
          <ContextRing percent={percent} risk={risk} />
        </div>
        <div className={s.numbers}>
          <div className={s.big}>
            {usage.estimated ? "≈ " : ""}
            {usedLabel} / {maxLabel}
          </div>
          <div className={s.percentLabel}>{percent.toFixed(1)}%</div>
          {typeof usage.compressions === "number" && usage.compressions > 0 ? (
            <div className={s.meta}>{usage.compressions} compression(s)</div>
          ) : null}
        </div>
      </div>

      <ContextGrid categories={usage.categories} total={total} />

      <div className={s.categories}>
        {usage.categories.map((category) => (
          <CategoryRow key={category.id} category={category} total={total} />
        ))}
      </div>

      <button
        type="button"
        className={s.toggle}
        onClick={() => setShowDetails((v) => !v)}
      >
        {showDetails ? "Hide raw usage" : "Show raw usage"}
      </button>

      {showDetails && usage.sessionUsage ? (
        <pre className={s.raw}>{JSON.stringify(usage.sessionUsage, null, 2)}</pre>
      ) : null}
    </div>
  );
}

function ContextRing({ percent, risk }: { percent: number; risk: ContextRisk }) {
  const size = 48;
  const radius = (size - 6) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={s.ring} data-risk={risk}>
      <circle
        className={s.ringTrack}
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth="6"
      />
      <circle
        className={s.ringValue}
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth="6"
        strokeLinecap={clamped > 0 ? "round" : "butt"}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
