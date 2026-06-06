import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchJSON, postJSON } from "@/lib/transport";
import { forceExistingGatewayReconnect } from "@/lib/gateway-client";
import { runtime } from "@/lib/runtime";
import {
  GATEWAY_RESTART_ACTION_NAME,
  classifyGatewayActionStatus,
  gatewayRestartResponseError,
  isGatewayRestartBusy,
  isGatewayRestartLocked,
  type GatewayActionStatusResponse,
  type GatewayRestartPhase,
  type GatewayRestartResponse,
} from "@/lib/gateway-restart";

const POLL_INTERVAL_MS = 1_500;
const MAX_POLL_ATTEMPTS = 40;
const MAX_STATUS_FAILURES_BEFORE_FALLBACK = 2;
const SUCCESS_RESET_MS = 10_000;

interface GatewayRestartState {
  phase: GatewayRestartPhase;
  message: string | null;
  pid?: number | null;
}

const INITIAL_STATE: GatewayRestartState = {
  phase: "idle",
  message: null,
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error || "Gateway 重启失败");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function useGatewayRestartAction() {
  const queryClient = useQueryClient();
  const [state, setReactState] = useState<GatewayRestartState>(INITIAL_STATE);
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const runIdRef = useRef(0);
  const resetTimerRef = useRef<number | null>(null);

  const setState = useCallback((next: GatewayRestartState) => {
    stateRef.current = next;
    if (mountedRef.current) setReactState(next);
  }, []);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  const scheduleSuccessReset = useCallback(() => {
    clearResetTimer();
    resetTimerRef.current = window.setTimeout(() => {
      if (stateRef.current.phase === "success") {
        setState(INITIAL_STATE);
      }
    }, SUCCESS_RESET_MS);
  }, [clearResetTimer, setState]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      clearResetTimer();
      runIdRef.current += 1;
    };
  }, [clearResetTimer]);

  const refreshAfterRestart = useCallback(async () => {
    await Promise.allSettled([
      runtime.refreshGatewayUrl(),
      queryClient.invalidateQueries({ queryKey: ["status"] }),
      queryClient.invalidateQueries({ queryKey: ["desktop-runtime-info"] }),
    ]);
    forceExistingGatewayReconnect("gateway-restart");
  }, [queryClient]);

  const finishSuccess = useCallback(async (runId: number, message: string) => {
    if (!mountedRef.current || runIdRef.current !== runId) return;
    setState({ phase: "success", message });
    scheduleSuccessReset();
    await refreshAfterRestart();
  }, [refreshAfterRestart, scheduleSuccessReset, setState]);

  const trackRestart = useCallback(async (runId: number) => {
    let statusFailures = 0;

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      await sleep(POLL_INTERVAL_MS);
      if (!mountedRef.current || runIdRef.current !== runId) return;

      try {
        const status = await fetchJSON<GatewayActionStatusResponse>(
          `/api/actions/${encodeURIComponent(GATEWAY_RESTART_ACTION_NAME)}/status?lines=40`,
        );
        statusFailures = 0;
        if (!mountedRef.current || runIdRef.current !== runId) return;

        const classification = classifyGatewayActionStatus(status);
        if (!classification.done) {
          setState({
            phase: "running",
            message: classification.message,
            pid: status.pid,
          });
          continue;
        }

        if (classification.ok) {
          await finishSuccess(runId, classification.message);
        } else {
          setState({
            phase: "error",
            message: classification.message,
            pid: status.pid,
          });
        }
        return;
      } catch {
        statusFailures += 1;
        if (statusFailures >= MAX_STATUS_FAILURES_BEFORE_FALLBACK) {
          await finishSuccess(runId, "已发起 Gateway 重启，正在刷新连接…");
          return;
        }
      }
    }

    await finishSuccess(runId, "已发起 Gateway 重启，正在后台完成…");
  }, [finishSuccess, setState]);

  const restart = useCallback(async () => {
    if (isGatewayRestartBusy(stateRef.current.phase)) return;

    clearResetTimer();
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setState({ phase: "starting", message: "正在请求重启 Gateway…" });

    try {
      await runtime.refreshGatewayUrl();
      if (!mountedRef.current || runIdRef.current !== runId) return;

      const response = await postJSON<GatewayRestartResponse>("/api/gateway/restart", {});
      if (!mountedRef.current || runIdRef.current !== runId) return;

      const structuredError = gatewayRestartResponseError(response);
      if (structuredError) throw new Error(structuredError);

      const pid = response.pid ?? null;
      setState({
        phase: "running",
        message: pid ? `已发起 Gateway 重启（PID ${pid}），等待完成…` : "已发起 Gateway 重启，等待完成…",
        pid,
      });
      void trackRestart(runId);
    } catch (error) {
      if (!mountedRef.current || runIdRef.current !== runId) return;
      setState({
        phase: "error",
        message: errorMessage(error),
      });
    }
  }, [clearResetTimer, setState, trackRestart]);

  const reset = useCallback(() => {
    clearResetTimer();
    runIdRef.current += 1;
    setState(INITIAL_STATE);
  }, [clearResetTimer, setState]);

  return {
    ...state,
    busy: isGatewayRestartBusy(state.phase),
    locked: isGatewayRestartLocked(state.phase),
    restart,
    reset,
  };
}
