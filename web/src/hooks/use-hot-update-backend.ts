import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import type { HotUpdateBackendResult, HotUpdateProgressPayload } from "@hermes/protocol";
import { forceExistingGatewayReconnect } from "@/lib/gateway-client";
import { runtime } from "@/lib/runtime";
import { runtimeUpdatingAtom } from "@/stores/ui";

const RUNTIME_INFO_KEY = ["desktop-runtime-info"] as const;
const MAX_PROGRESS_LINES = 200;

/** Pure helper: append one hot-update progress line, capping the log. */
export function appendHotUpdateProgress(
  progress: Array<{ phase: string; percent?: number; message: string }> | undefined,
  payload: HotUpdateProgressPayload,
): Array<{ phase: string; percent?: number; message: string }> {
  return [...(progress ?? []), payload].slice(-MAX_PROGRESS_LINES);
}

async function refreshDesktopGateway(): Promise<void> {
  if (window.hermesDesktop?.refreshGatewayUrl) {
    await runtime.refreshGatewayUrl();
    forceExistingGatewayReconnect("hot-update");
  }
}

/**
 * Dev-source backend hot update: pulls the local Hermes-CN-Core checkout,
 * re-installs it into the dev-runtime, and restarts the managed dashboard.
 * Only meaningful for `local-source` dev runtimes — the panel hides the button
 * otherwise, and the Rust command refuses to run.
 */
export function useHotUpdateBackend() {
  const qc = useQueryClient();
  const setUpdating = useSetAtom(runtimeUpdatingAtom);

  useEffect(() => {
    if (!window.hermesDesktop?.onHotUpdateProgress) return;
    const unlisten = window.hermesDesktop.onHotUpdateProgress((payload) => {
      setUpdating((state) => {
        if (!state.active || state.mode !== "hot-update") return state;
        return {
          ...state,
          progress: appendHotUpdateProgress(state.progress, payload),
        };
      });
    });
    return unlisten;
  }, [setUpdating]);

  return useMutation<HotUpdateBackendResult, Error, { sourceRoot?: string; skipGit?: boolean }>({
    mutationFn: (input) => window.hermesDesktop!.hotUpdateBackend!(input ?? {}),
    onMutate: () => {
      setUpdating({ active: true, mode: "hot-update", progress: [] });
    },
    onSettled: async () => {
      // The dashboard restarts on success (token rotates); a partial failure
      // may still have restarted it, so always resync.
      await refreshDesktopGateway();
      await qc.invalidateQueries({ queryKey: RUNTIME_INFO_KEY });
      setUpdating({ active: false });
    },
  });
}
