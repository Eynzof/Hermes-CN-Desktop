import { useMemo } from "react";
import { useAtomValue } from "jotai";
import {
  chatRuntimeBySessionAtom,
  createEmptyChatRuntime,
  gwSessionIdAtom,
  type ChatRuntimeBySession,
  type ChatSessionRuntime,
} from "@/stores/chat";
import { isRuntimeRunning } from "@/lib/session-activity";
import { resolveGatewaySessionId, resolvePersistentSessionId } from "@/lib/session-map";

export interface SessionResolution {
  restSessionId: string | undefined;
  activeMappedGatewaySessionId: string | undefined;
  runtimeSessionId: string | undefined;
  usageGatewaySessionId: string | undefined;
  runtime: ChatSessionRuntime;
  runtimeIsBusy: boolean;
  isGatewayLinked: boolean;
  isLiveSession: boolean;
}

// Pure so it can be unit-tested without React. Decides which runtime bucket the
// detail view should render for `taskId`.
export function resolveSessionRuntime(
  taskId: string | undefined,
  gwSessionId: string | null,
  runtimeBySession: ChatRuntimeBySession,
): SessionResolution {
  const restSessionId = resolvePersistentSessionId(taskId);

  // The live gateway session is the ground truth for what is streaming *right
  // now*. When it belongs to the same persistent session this route is showing,
  // prefer it directly. One persistent id can map to several gateway ids, so the
  // reverse lookup (resolveGatewaySessionId) is ambiguous, but the forward
  // lookup off the live id is not. Trusting the live id keeps the optimistic
  // user message + streaming assistant reading from the bucket the send wrote
  // into, instead of an orphaned empty runtime — even if the map is still dirty.
  const liveGatewaySessionId =
    gwSessionId && resolvePersistentSessionId(gwSessionId) === restSessionId
      ? gwSessionId
      : undefined;
  const mappedGatewaySessionId = liveGatewaySessionId ?? resolveGatewaySessionId(taskId);
  const activeMappedGatewaySessionId =
    mappedGatewaySessionId &&
    (gwSessionId === mappedGatewaySessionId || runtimeBySession[mappedGatewaySessionId])
      ? mappedGatewaySessionId
      : undefined;
  const runtimeSessionId =
    taskId && runtimeBySession[taskId] ? taskId : activeMappedGatewaySessionId;
  const runtime = taskId
    ? runtimeBySession[runtimeSessionId ?? taskId] ?? createEmptyChatRuntime()
    : createEmptyChatRuntime();
  const runtimeIsBusy = isRuntimeRunning(runtime);
  const isGatewayLinked = Boolean(
    taskId &&
      (gwSessionId === taskId ||
        gwSessionId === activeMappedGatewaySessionId ||
        resolvePersistentSessionId(gwSessionId ?? undefined) === restSessionId),
  );

  // Stay in live mode whenever runtime messages have unsynced content, regardless
  // of streamStatus. Live messages carry richer metadata (TTFT, duration, cost)
  // than REST stored messages, so detail can deduplicate them against stored data.
  const isLiveSession =
    isGatewayLinked ||
    runtimeIsBusy ||
    runtime.pendingApprovals.length > 0 ||
    runtime.messages.length > 0;

  return {
    restSessionId,
    activeMappedGatewaySessionId,
    runtimeSessionId,
    usageGatewaySessionId: runtimeSessionId ?? activeMappedGatewaySessionId,
    runtime,
    runtimeIsBusy,
    isGatewayLinked,
    isLiveSession,
  };
}

export function useSessionResolution(taskId: string | undefined) {
  const gwSessionId = useAtomValue(gwSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);

  return useMemo(
    () => resolveSessionRuntime(taskId, gwSessionId, runtimeBySession),
    [gwSessionId, runtimeBySession, taskId],
  );
}
