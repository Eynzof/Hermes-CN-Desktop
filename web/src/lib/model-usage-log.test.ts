import { beforeEach, describe, expect, it } from "vitest";
import {
  modelUsageKey,
  rankRecentModels,
  readModelUsageLog,
  recordModelUsage,
  type ModelUsageEntry,
} from "./model-usage-log";
import { __resetUiStoreForTests } from "./ui-store";

const NOW = new Date("2026-05-16T10:00:00Z").getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("modelUsageKey", () => {
  it("combines provider and model into a stable separator key", () => {
    expect(modelUsageKey("minimax-cn", "MiniMax-M2.7")).toBe("minimax-cn:MiniMax-M2.7");
  });

  it("treats missing provider as empty string", () => {
    expect(modelUsageKey(undefined, "qwen-plus")).toBe(":qwen-plus");
  });
});

describe("recordModelUsage", () => {
  beforeEach(() => {
    __resetUiStoreForTests();
  });

  it("creates an entry on first pick", () => {
    recordModelUsage({ model: "MiniMax-M2.7", provider: "minimax-cn" }, NOW);
    const log = readModelUsageLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      key: "minimax-cn:MiniMax-M2.7",
      model: "MiniMax-M2.7",
      provider: "minimax-cn",
      count: 1,
      lastUsedAt: NOW,
    });
  });

  it("increments count and updates lastUsedAt on repeat pick", () => {
    recordModelUsage({ model: "MiniMax-M2.7", provider: "minimax-cn" }, NOW - HOUR);
    recordModelUsage({ model: "MiniMax-M2.7", provider: "minimax-cn" }, NOW);
    const log = readModelUsageLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ count: 2, lastUsedAt: NOW });
  });

  it("treats same model with different providers as separate entries", () => {
    recordModelUsage({ model: "deepseek-v4-pro", provider: "deepseek" }, NOW);
    recordModelUsage({ model: "deepseek-v4-pro", provider: "openrouter" }, NOW);
    expect(readModelUsageLog()).toHaveLength(2);
  });

  it("ignores blank model names", () => {
    recordModelUsage({ model: "  ", provider: "deepseek" }, NOW);
    expect(readModelUsageLog()).toHaveLength(0);
  });
});

describe("rankRecentModels", () => {
  function makeEntry(model: string, count: number, lastUsedAt: number): ModelUsageEntry {
    return {
      key: modelUsageKey("p", model),
      model,
      provider: "p",
      count,
      lastUsedAt,
    };
  }

  it("returns empty when nothing falls inside the recency window", () => {
    const old = makeEntry("A", 99, NOW - 30 * DAY);
    expect(rankRecentModels([old], { now: NOW, windowMs: 7 * DAY })).toEqual([]);
  });

  it("limits results", () => {
    const entries = [
      makeEntry("A", 1, NOW),
      makeEntry("B", 1, NOW - HOUR),
      makeEntry("C", 1, NOW - 2 * HOUR),
      makeEntry("D", 1, NOW - 3 * HOUR),
    ];
    const ranked = rankRecentModels(entries, { now: NOW, limit: 2 });
    expect(ranked.map((e) => e.model)).toEqual(["A", "B"]);
  });

  it("a single recent pick beats a stale-but-frequent one", () => {
    const fresh = makeEntry("Fresh", 1, NOW - 5 * 60_000); // 5 min ago
    const stale = makeEntry("Stale", 50, NOW - 6 * DAY);   // 6 days ago, 50 picks
    const ranked = rankRecentModels([stale, fresh], { now: NOW, limit: 2 });
    expect(ranked[0].model).toBe("Fresh");
  });

  it("frequency wins when recency is comparable", () => {
    const frequent = makeEntry("Frequent", 30, NOW - HOUR);
    const occasional = makeEntry("Occasional", 1, NOW - HOUR);
    const ranked = rankRecentModels([frequent, occasional], { now: NOW, limit: 2 });
    expect(ranked[0].model).toBe("Frequent");
  });
});
