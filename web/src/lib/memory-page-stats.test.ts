import { describe, expect, it } from "vitest";
import { formatMemoryPageStat, memoryPageStats } from "./memory-page-stats";
import type { MemoryInfo } from "./runtime";

function memoryInfo(overrides: Partial<MemoryInfo> = {}): MemoryInfo {
  const base: MemoryInfo = {
    memory: {
      content: "alpha\n§\nbeta",
      exists: true,
      lastModified: 1,
      entries: [
        { index: 0, content: "alpha" },
        { index: 1, content: "beta" },
      ],
      charCount: 12,
      charLimit: 2200,
    },
    user: {
      content: "用户画像",
      exists: true,
      lastModified: 1,
      charCount: 4,
      charLimit: 1375,
    },
    stats: { totalSessions: 999, totalMessages: 888 },
  };
  return { ...base, ...overrides };
}

describe("memoryPageStats", () => {
  it("derives page-local stats without depending on session totals", () => {
    expect(memoryPageStats(memoryInfo())).toEqual([
      { label: "记忆", value: 2 },
      { label: "记忆字符", value: 12 },
      { label: "画像字符", value: 4 },
    ]);
  });
});

describe("formatMemoryPageStat", () => {
  it("formats finite positive integers and clamps invalid values to zero", () => {
    expect(formatMemoryPageStat(12345.8)).toBe("12,345");
    expect(formatMemoryPageStat(Number.NaN)).toBe("0");
    expect(formatMemoryPageStat(-3)).toBe("0");
  });
});
