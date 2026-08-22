import type { RotationStrategy } from "./types.js";

export const TTL_401 = 5 * 60 * 1_000;
export const TTL_429 = 60 * 60 * 1_000;
export const TTL_DEFAULT = 60 * 60 * 1_000;
export const TTL_SOLE = 60 * 1_000;
export const PRUNE_DEAD_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_MAX_CONCURRENT = 1;

export const STRATEGIES: RotationStrategy[] = ["fill_first", "round_robin", "least_used", "random"];
