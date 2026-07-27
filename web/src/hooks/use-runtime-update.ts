import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import type {
  RuntimeInfo,
  RuntimeInstallUpdateResult,
  RuntimeUpdateCheckResult,
  RuntimeUpdateStage,
} from "@hermes/protocol";
import { RUNTIME_UPDATE_STAGE_EVENT } from "@hermes/protocol";
import { runtime } from "@/lib/runtime";
import { raceAbort } from "@/lib/transport";
import { forceExistingGatewayReconnect } from "@/lib/gateway-client";
import { runtimeUpdateStageAtom, runtimeUpdatingAtom } from "@/stores/ui";

const RUNTIME_INFO_KEY = ["desktop-runtime-info"] as const;

function hasRuntimeBridge(): boolean {
  return typeof window !== "undefined" &&
    runtime.platform !== "web" &&
    Boolean(window.hermesDesktop?.getRuntimeInfo);
}

async function refreshDesktopGateway(): Promise<void> {
  if (window.hermesDesktop?.refreshGatewayUrl) {
    await runtime.refreshGatewayUrl();
    forceExistingGatewayReconnect("runtime-update");
  }
}

/**
 * Subscribe to the Rust-side runtime-update-stage events (update_stage.rs)
 * and mirror the latest stage into runtimeUpdateStageAtom. Mount once from a
 * window-level component (RuntimeUpdateOverlay) — only Tauri emits the event,
 * so non-Tauri platforms register nothing.
 */
export function useRuntimeUpdateStageListener() {
  const setStage = useSetAtom(runtimeUpdateStageAtom);
  useEffect(() => {
    if (runtime.platform !== "tauri") return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<RuntimeUpdateStage>(RUNTIME_UPDATE_STAGE_EVENT, (event) => {
          setStage(event.payload);
        }),
      )
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Event bridge unavailable (e.g. plain browser) — overlay falls back
        // to its stage-less copy.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setStage]);
}

export function useRuntimeInfo() {
  return useQuery<RuntimeInfo>({
    queryKey: RUNTIME_INFO_KEY,
    queryFn: ({ signal }) => raceAbort(window.hermesDesktop!.getRuntimeInfo!(), signal),
    enabled: hasRuntimeBridge(),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export function useCheckRuntimeUpdate() {
  return useMutation<RuntimeUpdateCheckResult>({
    mutationFn: () => window.hermesDesktop!.checkRuntimeUpdate!(),
  });
}

export function useInstallRuntimeUpdate() {
  const qc = useQueryClient();
  const setUpdating = useSetAtom(runtimeUpdatingAtom);
  const setStage = useSetAtom(runtimeUpdateStageAtom);
  return useMutation<RuntimeInstallUpdateResult>({
    mutationFn: () => window.hermesDesktop!.installRuntimeUpdate!(),
    // Raise the blocking overlay before the IPC call so the dashboard restart
    // window (stale token → 401) never surfaces to the user. Keep it up through
    // onSettled until the token has been refreshed.
    onMutate: () => {
      setStage(null);
      setUpdating({ active: true, mode: "install" });
    },
    onSettled: async () => {
      // Runs on success AND failure — a partial install can still have
      // restarted the dashboard, so always resync the rotated session token.
      await refreshDesktopGateway();
      await qc.invalidateQueries({ queryKey: RUNTIME_INFO_KEY });
      setUpdating({ active: false });
    },
  });
}

export function useRollbackRuntime() {
  const qc = useQueryClient();
  const setUpdating = useSetAtom(runtimeUpdatingAtom);
  const setStage = useSetAtom(runtimeUpdateStageAtom);
  return useMutation<RuntimeInstallUpdateResult>({
    mutationFn: () => window.hermesDesktop!.rollbackRuntime!(),
    onMutate: () => {
      setStage(null);
      setUpdating({ active: true, mode: "rollback" });
    },
    onSettled: async () => {
      await refreshDesktopGateway();
      await qc.invalidateQueries({ queryKey: RUNTIME_INFO_KEY });
      setUpdating({ active: false });
    },
  });
}
