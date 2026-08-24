import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secret/token values.
 *
 * The two values are encoded as UTF-8 bytes and copied into equal-length,
 * zero-padded buffers, so `crypto.timingSafeEqual` always compares buffers of
 * the same length. This avoids the length-based early-exit of `a === b`, which
 * leaks the secret length through timing, while still rejecting mismatches.
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  const length = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  return timingSafeEqual(paddedA, paddedB);
}
