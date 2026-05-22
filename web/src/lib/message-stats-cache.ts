import type { HermesMessageMetadata } from "@hermes/protocol";
import { getUiTurnStats, recordUiTurnStats, stableTextHash } from "@/lib/ui-store";

export async function persistMessageStats(
  sessionId: string,
  metadata: HermesMessageMetadata,
  text?: string,
): Promise<void> {
  await recordUiTurnStats({
    id: `legacy-${sessionId}-${Date.now()}`,
    sessionId,
    metadata,
    contentHash: stableTextHash(text),
    model: metadata.model,
    ttftMs: metadata.timing?.ttftMs,
    durationMs: metadata.timing?.durationMs,
    tokensInput: metadata.usage?.tokensInput,
    tokensOutput: metadata.usage?.tokensOutput,
    tokensTotal: metadata.usage?.tokensTotal,
    cacheRead: metadata.usage?.cacheRead,
    cacheWrite: metadata.usage?.cacheWrite,
    apiCalls: metadata.usage?.apiCalls,
    costUsd: metadata.costUsd ?? undefined,
    costStatus: metadata.costStatus,
    finishReason: metadata.finishReason,
    createdAt: Date.now(),
  });
}

export async function findCachedMetadata(
  sessionId: string,
): Promise<HermesMessageMetadata | undefined> {
  const rows = await getUiTurnStats(sessionId);
  return [...rows].reverse().find((row) => row.metadata)?.metadata;
}
