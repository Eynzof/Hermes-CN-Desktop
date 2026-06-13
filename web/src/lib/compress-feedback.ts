import type { SessionCompressResult } from "@hermes/protocol";

function formatTokens(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/**
 * Build the localized system-notice text shown after a manual /compress.
 * Derives wording from the backend's structured before/after counts rather than
 * its English `summary`, so the Chinese UI stays consistent.
 */
export function formatCompressNotice(result: SessionCompressResult, focus = ""): string {
  const before = result.before_messages;
  const after = result.after_messages;
  const beforeTok = result.before_tokens;
  const afterTok = result.after_tokens;
  const focusText = focus.trim();
  const focusSuffix = focusText ? `（聚焦：${focusText}）` : "";

  const noChange =
    result.removed === 0 ||
    (typeof before === "number" && typeof after === "number" && before === after);

  if (noChange) {
    const size = typeof beforeTok === "number" ? `约 ${formatTokens(beforeTok)} tokens` : "";
    const count = typeof before === "number" ? `${before} 条消息` : "";
    const detail = [count, size].filter(Boolean).join("、");
    return `上下文无需压缩${focusSuffix}${detail ? `：当前${detail}` : ""}。`;
  }

  const msgPart =
    typeof before === "number" && typeof after === "number" ? `${before} → ${after} 条消息` : "";
  const tokPart =
    typeof beforeTok === "number" && typeof afterTok === "number"
      ? `约 ${formatTokens(beforeTok)} → ${formatTokens(afterTok)} tokens`
      : "";
  const detail = [msgPart, tokPart].filter(Boolean).join("，");
  return `已压缩上下文${focusSuffix}${detail ? `：${detail}` : ""}。`;
}
