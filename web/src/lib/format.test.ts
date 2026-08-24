import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dayKey,
  dayLabel,
  formatCostCny,
  formatCostUsd,
  formatDurationMs,
  formatElapsedTimer,
  formatHeroTimestamp,
  formatTokPerSec,
  formatTokens,
  getGreeting,
  isToday,
  relativeTime,
  timeOfDay,
} from "./format";

describe("formatTokens", () => {
  it("renders < 1k as integer", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });
  it("renders thousands with one decimal until 100k", () => {
    expect(formatTokens(1_200)).toBe("1.2k");
    expect(formatTokens(99_499)).toBe("99.5k");
  });
  it("rounds large k values to integer", () => {
    expect(formatTokens(120_000)).toBe("120k");
  });
  it("renders millions", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
  it("escalates k→M instead of showing 1000k", () => {
    expect(formatTokens(999_500)).toBe("1.0M");
    expect(formatTokens(999_999)).toBe("1.0M");
  });
  it("escalates M→B instead of showing 1000.0M", () => {
    expect(formatTokens(999_500_000)).toBe("1.0B");
    expect(formatTokens(1_500_000_000)).toBe("1.5B");
  });
  it("returns dash for null/NaN", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(Number.NaN)).toBe("—");
  });
});

describe("formatElapsedTimer", () => {
  it("renders seconds under a minute", () => {
    expect(formatElapsedTimer(0)).toBe("0:00");
    expect(formatElapsedTimer(3_000)).toBe("0:03");
    expect(formatElapsedTimer(47_000)).toBe("0:47");
  });
  it("renders minutes and seconds", () => {
    expect(formatElapsedTimer(60_000)).toBe("1:00");
    expect(formatElapsedTimer(83_000)).toBe("1:23");
    expect(formatElapsedTimer(545_000)).toBe("9:05");
  });
  it("renders double-digit minutes", () => {
    expect(formatElapsedTimer(754_000)).toBe("12:34");
  });
  it("handles negative as 0:00", () => {
    expect(formatElapsedTimer(-1000)).toBe("0:00");
  });
  it("floors partial seconds", () => {
    expect(formatElapsedTimer(3_999)).toBe("0:03");
  });
});

describe("formatDurationMs", () => {
  it("uses ms below 1s", () => {
    expect(formatDurationMs(0)).toBe("0ms");
    expect(formatDurationMs(420)).toBe("420ms");
    expect(formatDurationMs(999)).toBe("999ms");
  });
  it("uses seconds below 1 minute", () => {
    expect(formatDurationMs(1_000)).toBe("1.0s");
    expect(formatDurationMs(4_250)).toBe("4.3s");
  });
  it("uses m+s above a minute", () => {
    expect(formatDurationMs(60_000)).toBe("1m00s");
    expect(formatDurationMs(125_000)).toBe("2m05s");
  });
  it("returns dash for negative or null", () => {
    expect(formatDurationMs(-1)).toBe("—");
    expect(formatDurationMs(null)).toBe("—");
  });
});

describe("formatTokPerSec", () => {
  it("uses one decimal below 100", () => {
    expect(formatTokPerSec(82.4)).toBe("82.4");
  });
  it("rounds to integer at and above 100", () => {
    expect(formatTokPerSec(100)).toBe("100");
    expect(formatTokPerSec(456.7)).toBe("457");
  });
});

describe("formatCostUsd", () => {
  it("renders zero", () => {
    expect(formatCostUsd(0)).toBe("$0");
  });
  it("renders sub-cent as a clamp", () => {
    expect(formatCostUsd(0.005)).toBe("<$0.01");
  });
  it("renders cents with three decimals", () => {
    expect(formatCostUsd(0.018)).toBe("$0.018");
  });
  it("renders dollars with two decimals", () => {
    expect(formatCostUsd(1.234)).toBe("$1.23");
  });
});

describe("formatCostCny", () => {
  it("renders zero", () => {
    expect(formatCostCny(0)).toBe("≈¥0");
  });
  it("applies the approximate USD/CNY rate", () => {
    expect(formatCostCny(1)).toBe("≈¥6.80");
    expect(formatCostCny(0.5)).toBe("≈¥3.40");
  });
  it("clamps tiny amounts", () => {
    expect(formatCostCny(0.0001)).toBe("<≈¥0.01");
  });
  it("returns dash for null/NaN", () => {
    expect(formatCostCny(null)).toBe("—");
    expect(formatCostCny(Number.NaN)).toBe("—");
  });
});

describe("getGreeting", () => {
  it("covers all four time slots", () => {
    expect(getGreeting(2)).toMatch(/夜深了/);
    expect(getGreeting(8)).toMatch(/早上好/);
    expect(getGreeting(14)).toMatch(/下午好/);
    expect(getGreeting(20)).toMatch(/晚上好/);
  });
});

describe("relativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("renders 刚刚 within a minute", () => {
    const now = Date.now() / 1000;
    expect(relativeTime(now - 30)).toBe("刚刚");
  });
  it("renders 分前 within an hour", () => {
    const now = Date.now() / 1000;
    expect(relativeTime(now - 600)).toBe("10分前");
  });
  it("renders 时前 within a day", () => {
    const now = Date.now() / 1000;
    expect(relativeTime(now - 7200)).toBe("2时前");
  });
  it("renders 天前 within a week", () => {
    const now = Date.now() / 1000;
    expect(relativeTime(now - 86400 * 3)).toBe("3天前");
  });
});

describe("formatHeroTimestamp", () => {
  it("includes date, weekday, time, tz", () => {
    const date = new Date("2026-04-28T16:42:00+08:00");
    const out = formatHeroTimestamp(date);
    // Skip exact tz check because test env tz varies; just shape-check.
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} · 周[日一二三四五六] · \d{2}:\d{2} /);
  });
});

describe("dayKey / dayLabel / timeOfDay / isToday", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin to a wall-clock moment in the local timezone the test runs in.
    vi.setSystemTime(new Date(2026, 3, 28, 12, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  function unix(year: number, month: number, day: number, hour = 0, minute = 0): number {
    return Math.floor(new Date(year, month - 1, day, hour, minute).getTime() / 1000);
  }

  it("dayKey buckets by start-of-day in local tz", () => {
    const morning = unix(2026, 4, 28, 9, 30);
    const evening = unix(2026, 4, 28, 22, 15);
    expect(dayKey(morning)).toBe(dayKey(evening));
  });

  it("dayKey differs across calendar days", () => {
    expect(dayKey(unix(2026, 4, 28))).not.toBe(dayKey(unix(2026, 4, 29)));
  });

  it("dayLabel renders 今日 for today", () => {
    expect(dayLabel(unix(2026, 4, 28, 8))).toBe("今日");
  });

  it("dayLabel renders 昨日 for yesterday", () => {
    expect(dayLabel(unix(2026, 4, 27, 22))).toBe("昨日");
  });

  it("dayLabel renders M月D日 for same year", () => {
    expect(dayLabel(unix(2026, 1, 5))).toBe("1月5日");
  });

  it("dayLabel renders YYYY年M月D日 for prior year", () => {
    expect(dayLabel(unix(2025, 12, 25))).toBe("2025年12月25日");
  });

  it("timeOfDay renders zero-padded HH:MM", () => {
    expect(timeOfDay(unix(2026, 4, 28, 9, 5))).toBe("09:05");
    expect(timeOfDay(unix(2026, 4, 28, 23, 59))).toBe("23:59");
  });

  it("isToday distinguishes same vs prior day", () => {
    expect(isToday(unix(2026, 4, 28, 0, 1))).toBe(true);
    expect(isToday(unix(2026, 4, 27, 23, 59))).toBe(false);
  });
});
