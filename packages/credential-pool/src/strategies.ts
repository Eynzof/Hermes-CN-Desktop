import type { PooledCredential, RotationStrategy } from "./types.js";

export function selectCredential(
  entries: PooledCredential[],
  strategy: RotationStrategy,
  roundRobinCursor = 0,
): PooledCredential | null {
  const available = entries.filter((e) => e.last_status !== "exhausted" && e.last_status !== "dead");
  if (!available.length) return null;
  switch (strategy) {
    case "fill_first":
      return available.reduce((best, cur) => (cur.request_count < best.request_count ? cur : best));
    case "round_robin":
      return available[roundRobinCursor % available.length];
    case "least_used":
      return available.reduce((best, cur) => (cur.request_count < best.request_count ? cur : best));
    case "random":
      return available[Math.floor(Math.random() * available.length)];
    default:
      return available[0];
  }
}
