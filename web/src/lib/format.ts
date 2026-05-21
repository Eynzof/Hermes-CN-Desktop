export function formatTokens(value: number | undefined | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const n = Math.max(0, value);
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1_000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
}

export function formatDurationMs(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

export function formatTokPerSec(value: number | undefined | null): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  return value >= 100 ? `${Math.round(value)}` : value.toFixed(1);
}

export function formatElapsedTimer(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatCostUsd(value: number | undefined | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return `<$0.01`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

const USD_TO_CNY_APPROXIMATE_RATE = 6.8;

export function formatCostCny(usd: number | undefined | null): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  const cny = Math.max(0, usd) * USD_TO_CNY_APPROXIMATE_RATE;
  if (cny === 0) return "≈¥0";
  if (cny < 0.01) return `<≈¥0.01`;
  return `≈¥${cny.toFixed(2)}`;
}

export function getGreeting(hour: number): string {
  if (hour < 6) return "夜深了，休息一下？";
  if (hour < 12) return "早上好，开始今天的工作";
  if (hour < 18) return "下午好，我们该做什么？";
  return "晚上好，给今天收收尾？";
}

import {
  differenceInCalendarDays,
  format as formatDate,
  isToday as dateFnsIsToday,
  startOfDay,
} from "date-fns";

export function dayKey(unixSec: number): string {
  return String(startOfDay(unixSec * 1000).getTime());
}

export function dayLabel(unixSec: number): string {
  const target = new Date(unixSec * 1000);
  const today = new Date();
  const diffDays = differenceInCalendarDays(today, target);
  if (diffDays === 0) return "今日";
  if (diffDays === 1) return "昨日";
  if (target.getFullYear() === today.getFullYear()) {
    return formatDate(target, "M月d日");
  }
  return formatDate(target, "yyyy年M月d日");
}

export function timeOfDay(unixSec: number): string {
  return formatDate(new Date(unixSec * 1000), "HH:mm");
}

export function isToday(unixSec: number): boolean {
  return dateFnsIsToday(new Date(unixSec * 1000));
}

export function relativeTime(unixSec: number): string {
  const diff = ((Date.now() / 1000 - unixSec) | 0);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${(diff / 60) | 0}分前`;
  if (diff < 86400) return `${(diff / 3600) | 0}时前`;
  if (diff < 604800) return `${(diff / 86400) | 0}天前`;
  return new Date(unixSec * 1000).toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
}

const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function formatHeroTimestamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const weekday = WEEKDAY_ZH[date.getDay()];
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const tzOffset = -date.getTimezoneOffset();
  const tzAbbr =
    tzOffset === 480
      ? "CST"
      : `UTC${tzOffset >= 0 ? "+" : ""}${Math.floor(tzOffset / 60)}`;
  return `${yyyy}-${mm}-${dd} · ${weekday} · ${hh}:${mi} ${tzAbbr}`;
}
