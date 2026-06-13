import { useEffect, useState } from "react";
import type { ChatSessionRuntime } from "@/stores/chat";
import { STALL_WATCHDOG_THRESHOLD_MS, streamSilenceMs } from "@/lib/session-activity";

/** How often the watchdog re-evaluates silence while a turn is running. */
const TICK_MS = 2_000;

export interface StallState {
  /** True once the backend has been silent for >= threshold on a running turn. */
  isStalled: boolean;
  /** Current backend-silence in ms (0 when not running). */
  silenceMs: number;
}

/**
 * Task-level stall watchdog, independent of the connection heartbeat.
 *
 * The gateway WS heartbeat (`gateway-client.ts`) only proves the
 * desktop↔gateway socket is alive — it keeps getting pong-equivalent frames
 * even while the agent turn is wedged on a dead model-provider call, so the
 * elapsed timer ticks up forever with no progress. This hook watches the time
 * since the backend last sent *anything* for the running turn and flips
 * `isStalled` once it crosses the threshold, letting the UI surface a notice
 * and an interrupt/retry affordance.
 *
 * The clock resets automatically the moment any backend event arrives (every
 * applied gateway event bumps `runtime.lastActivityAt`), so a turn that
 * recovers clears the stall on its own.
 */
export function useStallWatchdog(
  runtime: ChatSessionRuntime | undefined,
  thresholdMs: number = STALL_WATCHDOG_THRESHOLD_MS,
): StallState {
  const [silenceMs, setSilenceMs] = useState(() => streamSilenceMs(runtime) ?? 0);

  const running = streamSilenceMs(runtime) !== null;
  // Depend on the stable activity markers (not the runtime object identity,
  // which changes on every delta) so the interval is only re-armed when the
  // turn starts/stops or the backend speaks — not on every token.
  const lastActivityAt = runtime?.lastActivityAt;
  const turnStartedAt = runtime?.turnStartedAt;

  useEffect(() => {
    if (!running) {
      setSilenceMs(0);
      return;
    }
    const update = () => setSilenceMs(streamSilenceMs(runtime) ?? 0);
    update();
    const id = window.setInterval(update, TICK_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, lastActivityAt, turnStartedAt]);

  return { isStalled: running && silenceMs >= thresholdMs, silenceMs };
}
