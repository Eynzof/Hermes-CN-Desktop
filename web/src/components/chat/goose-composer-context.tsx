import { useEffect, useRef, useState } from "react";
import {
  contextUsagePercent,
  contextUsageRisk,
  type ContextRisk,
} from "@/lib/context-usage";
import type { ComposerContextUsage } from "./composer-types";
import s from "./goose-composer.module.css";

function formatTokenCount(value?: number): string {
  if (!Number.isFinite(value)) return "-";
  const num = Number(value);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num >= 10_000_000 ? 0 : 1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(num >= 100_000 ? 0 : 1)}k`;
  return String(Math.max(0, Math.round(num)));
}

function ContextRing({ percent }: { percent: number }) {
  const size = 18;
  const radius = (size - 3) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(100, percent)) / 100;
  const offset = circumference - progress * circumference;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={s.contextRing}
      aria-hidden="true"
    >
      <circle
        className={s.contextRingTrack}
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth="2.5"
      />
      <circle
        className={s.contextRingValue}
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap={progress > 0 ? "round" : "butt"}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export function contextRiskText(risk: ContextRisk, active: boolean): string {
  if (risk === "danger") {
    return active
      ? "上下文已超出模型窗口，当前响应可能卡住，或使用上下文更大的模型。"
      : "上下文已超出模型窗口，等待 Hermes 自动压缩或返回错误，或使用上下文更大的模型。";
  }
  if (risk === "warning") return "上下文接近 Hermes 自动压缩阈值，触发后会显示已压缩次数。";
  return "";
}

export function ContextIndicator({
  usage,
  active = false,
}: {
  usage: ComposerContextUsage;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const rawPercent = contextUsagePercent(usage);
  const percent = Math.max(0, Math.min(100, rawPercent ?? 0));
  const risk = contextUsageRisk(usage);
  const usedLabel = formatTokenCount(usage.used);
  const estimatedPrefix = usage.estimated && typeof usage.used === "number" ? "约 " : "";
  const label = usage.max
    ? `${estimatedPrefix}${usedLabel} / ${formatTokenCount(usage.max)}`
    : `${estimatedPrefix}${usedLabel}`;
  const displayPercent = rawPercent ?? percent;
  const percentLabel = rawPercent === undefined
    ? "-"
    : `${displayPercent > 0 && displayPercent < 10 ? displayPercent.toFixed(1) : Math.round(displayPercent)}%`;
  const contextTitle = usage.model
    ? `${usage.model} · 上下文窗口 ${label}`
    : `上下文窗口 ${label}`;
  const title = active ? `Hermes 正在响应 · ${contextTitle}` : contextTitle;
  const riskText = contextRiskText(risk, active);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <span
      ref={rootRef}
      className={s.contextWrap}
      title={title}
    >
      <button
        type="button"
        className={s.contextButton}
        data-open={open}
        data-active={active}
        data-risk={risk}
        aria-label="上下文窗口"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ContextRing percent={percent} />
        {active ? <span className={s.contextStatusDot} aria-hidden="true" /> : null}
      </button>
      {open ? (
        <span className={s.contextPopover} role="dialog" aria-label="上下文窗口">
          <span className={s.contextPopoverTitle}>上下文窗口</span>
          {usage.model ? <span className={s.contextPopoverModel}>{usage.model}</span> : null}
          <span className={s.contextPopoverMeter} aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </span>
          <span className={s.contextPopoverStats}>
            <span>{label}</span>
            <span>{percentLabel}</span>
          </span>
          {usage.estimated ? (
            <span className={s.contextPopoverMeta}>按当前已渲染消息估算，不使用累计账单 tokens</span>
          ) : null}
          {typeof usage.compressions === "number" && usage.compressions > 0 ? (
            <span className={s.contextPopoverMeta}>已压缩 {usage.compressions} 次</span>
          ) : null}
          {riskText ? (
            <span className={s.contextPopoverWarning} data-risk={risk}>
              {riskText}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
