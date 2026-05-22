import { readUiValue, removeUiValue, subscribeUiStore, writeUiValue } from "@/lib/ui-store";

// Records every model selection so the picker can surface "recently used"
// without a server round-trip. UI SQLite-backed; the per-renderer subscriber
// list lets open pickers refresh when a new selection comes in from another
// surface (panel composer vs. detail composer).

const STORAGE_KEY = "hermes:model-usage-log";
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 64;

export interface ModelUsageEntry {
  /** Stable id: `${provider}:${model}` so the same model under two providers
   * (e.g. deepseek via openrouter vs direct) tracks separately. */
  key: string;
  model: string;
  provider: string;
  providerName?: string;
  /** Total times the user has actively picked this combo. */
  count: number;
  /** ms epoch of the most recent pick. */
  lastUsedAt: number;
}

interface StoredShape {
  v: 1;
  entries: ModelUsageEntry[];
}

const subscribers = new Set<() => void>();

function notify() {
  subscribers.forEach((fn) => fn());
}

export function modelUsageKey(provider: string | undefined, model: string): string {
  return `${(provider ?? "").trim()}:${model.trim()}`;
}

export function readModelUsageLog(): ModelUsageEntry[] {
  try {
    const parsed = readUiValue<StoredShape | null>(STORAGE_KEY, null);
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(isValidEntry);
  } catch {
    return [];
  }
}

function isValidEntry(value: unknown): value is ModelUsageEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    typeof v.model === "string" &&
    typeof v.provider === "string" &&
    typeof v.count === "number" &&
    typeof v.lastUsedAt === "number"
  );
}

function writeModelUsageLog(entries: ModelUsageEntry[]): void {
  try {
    const trimmed = entries.slice(0, MAX_ENTRIES);
    const payload: StoredShape = { v: 1, entries: trimmed };
    writeUiValue(STORAGE_KEY, payload);
    notify();
  } catch {
    // UI store unavailable — silently drop the recording.
  }
}

export function recordModelUsage(
  selection: { model: string; provider?: string; providerName?: string },
  now: number = Date.now(),
): void {
  if (!selection.model.trim()) return;
  const key = modelUsageKey(selection.provider, selection.model);
  const existing = readModelUsageLog();
  const others = existing.filter((entry) => entry.key !== key);
  const prior = existing.find((entry) => entry.key === key);
  const next: ModelUsageEntry = {
    key,
    model: selection.model,
    provider: selection.provider ?? "",
    providerName: selection.providerName,
    count: (prior?.count ?? 0) + 1,
    lastUsedAt: now,
  };
  writeModelUsageLog([next, ...others]);
}

export function forgetModelUsage(key: string): void {
  const existing = readModelUsageLog();
  writeModelUsageLog(existing.filter((entry) => entry.key !== key));
}

export function clearModelUsageLog(): void {
  try {
    removeUiValue(STORAGE_KEY);
    notify();
  } catch {}
}

export interface RecentRankingOptions {
  /** Limit returned entries — default 3 (matches picker "最近用过" group). */
  limit?: number;
  /** Drop entries older than this window. Default 7 days. Set to Infinity
   * to keep all history. */
  windowMs?: number;
  /** Reference time for recency calc. Defaults to Date.now(). Tests pass a
   * fixed value to stay deterministic. */
  now?: number;
  /** Weight of frequency vs. recency in the composite score. Default 0.5
   * keeps recency dominant so a single fresh pick can outrank a stale-but-
   * frequent entry inside the 7-day window. */
  freqWeight?: number;
}

/**
 * Rank usage entries by a recency × frequency composite. The intuition:
 * something used 30 times yesterday should beat something used once 10
 * minutes ago, but a single pick five minutes ago should beat something used
 * 50 times last week. Both axes are normalised to 0..1 before mixing.
 */
export function rankRecentModels(
  entries: ModelUsageEntry[],
  options: RecentRankingOptions = {},
): ModelUsageEntry[] {
  const limit = options.limit ?? 3;
  const windowMs = options.windowMs ?? RECENT_WINDOW_MS;
  const now = options.now ?? Date.now();
  const freqWeight = options.freqWeight ?? 0.5;

  const inWindow = entries.filter((entry) => now - entry.lastUsedAt <= windowMs);
  if (inWindow.length === 0) return [];

  const maxCount = inWindow.reduce((acc, e) => Math.max(acc, e.count), 1);

  const scored = inWindow.map((entry) => {
    const ageMs = Math.max(0, now - entry.lastUsedAt);
    // Recency: 1.0 right now, ~0.5 at half-window, ~0 at window edge.
    const recencyScore = Math.max(0, 1 - ageMs / windowMs);
    const freqScore = entry.count / maxCount;
    const score = recencyScore + freqWeight * freqScore;
    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
}

// React hook entry point — kept dependency-light so non-React callers
// (record/forget) can stay in any context.
export function subscribeModelUsage(listener: () => void): () => void {
  subscribers.add(listener);
  const unsubscribe = subscribeUiStore(listener);
  return () => {
    subscribers.delete(listener);
    unsubscribe();
  };
}
