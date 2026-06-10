/**
 * Reconnect-driven session re-attach.
 *
 * The desktop gateway (Hermes dashboard) has NO socket-level replay/resume and
 * NO server-side event buffer: when the event stream drops (laptop sleep/wake,
 * dashboard restart, flaky network) the backend session keeps running but is
 * orphaned from the dead transport and gets reaped after a grace window.
 * Recovery is purely application-level — after the transport reconnects we must
 * re-issue `session.resume` so the server re-pins the live turn to the new
 * socket and the remaining deltas stream onto the SAME assistant message.
 *
 * Without this, a mid-turn drop loses the reply (the classic "回复要切走再切回来
 * 才看得见" / frozen "连接已断开" symptom). This mirrors the official desktop's
 * use-gateway-boot + use-session-actions behavior.
 *
 * Kept as a pure, dependency-injected function so it is unit-testable without
 * the jotai store / gateway-client singletons. See
 * docs/gateway-connection-overhaul.md (C2).
 */
export interface ReconnectResumeResult {
  session_id: string;
  resumed?: string;
}

export interface ReattachAfterReconnectDeps {
  /** The currently active gateway session id, or null/undefined if none is open. */
  getActiveSessionId: () => string | null | undefined;
  /** Map a (possibly stale) gateway session id to its persistent session id. */
  resolvePersistentId: (sessionId: string) => string;
  /** Issue `session.resume` for the given persistent id. */
  resume: (persistentId: string) => Promise<ReconnectResumeResult>;
  /** Called on success with the (possibly new) gateway id + the persistent id. */
  onResumed: (gatewaySessionId: string, persistentId: string) => void;
  /** Called when resume rejects or yields no session (session gone) so the caller can surface an error. */
  onResumeFailed: (error: unknown) => void;
}

export async function reattachAfterReconnect(deps: ReattachAfterReconnectDeps): Promise<void> {
  const activeSessionId = deps.getActiveSessionId();
  // Nothing open to re-pin — a fresh connect with no session is a no-op.
  if (!activeSessionId) return;

  const persistentId = deps.resolvePersistentId(activeSessionId);
  try {
    const result = await deps.resume(persistentId);
    if (!result?.session_id) {
      deps.onResumeFailed(new Error("session.resume returned no session_id"));
      return;
    }
    deps.onResumed(result.session_id, result.resumed ?? persistentId);
  } catch (error) {
    deps.onResumeFailed(error);
  }
}
