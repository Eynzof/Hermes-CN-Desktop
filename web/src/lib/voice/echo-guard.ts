/**
 * Voice Mode — TTS echo guard.
 *
 * Mirrors Python `is_tts_echo`: char-level similarity + sliding fragment window.
 */

export function isTtsEcho(spokenText: string, capturedText: string, threshold = 0.6, minFragment = 10): boolean {
  const a = normalizeForEcho(spokenText);
  const b = normalizeForEcho(capturedText);
  if (a.length < minFragment || b.length < minFragment) return false;

  // Sliding window over captured text.
  for (let start = 0; start <= b.length - minFragment; start++) {
    const end = Math.min(start + a.length, b.length);
    const fragment = b.slice(start, end);
    const ratio = lcsRatio(a, fragment);
    if (ratio >= threshold) return true;
  }
  return false;
}

function normalizeForEcho(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

function lcsRatio(a: string, b: string): number {
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (!shorter.length) return 0;
  const lcs = longestCommonSubsequenceLength(shorter, longer);
  return lcs / Math.max(a.length, b.length);
}

function longestCommonSubsequenceLength(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const prev = new Array(n + 1).fill(0);
  const curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    prev.fill(0);
    for (let k = 0; k <= n; k++) prev[k] = curr[k];
  }
  return curr[n];
}
