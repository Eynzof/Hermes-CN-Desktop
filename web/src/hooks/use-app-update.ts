import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import type {
  AppUpdateCheckResult,
  AppUpdateInstallResult,
  AppUpdateProgressPayload,
} from "@hermes/protocol";
import { forceExistingGatewayReconnect } from "@/lib/gateway-client";
import { recordRuntimeKernelVersion } from "@/lib/version-check";
import { runtime } from "@/lib/runtime";
import { runtimeUpdatingAtom } from "@/stores/ui";

const RUNTIME_INFO_KEY = ["desktop-runtime-info"] as const;
const MAX_PROGRESS_LINES = 200;

/**
 * Pure helper: append one progress event to the overlay state, capping the
 * log at MAX_PROGRESS_LINES. Exported for unit tests.
 *
 * Accepts the atom's loose progress shape ({ percent?: number }) because
 * hot-update progress lines omit `percent`; app-update lines always carry it.
 */
export type AppUpdateProgressLine = {
  phase: string;
  percent?: number;
  message: string;
};

export function appendAppUpdateProgress(
  state: { active: boolean; mode?: string; progress?: AppUpdateProgressLine[] },
  payload: AppUpdateProgressPayload,
): AppUpdateProgressLine[] {
  return [...(state.progress ?? []), payload].slice(-MAX_PROGRESS_LINES);
}

function hasAppUpdateBridge(): boolean {
  return (
    typeof window !== "undefined" &&
    runtime.platform !== "web" &&
    Boolean(window.hermesDesktop?.appUpdateCheck && window.hermesDesktop?.appUpdateInstall)
  );
}

async function refreshDesktopGateway(): Promise<void> {
  if (window.hermesDesktop?.refreshGatewayUrl) {
    await runtime.refreshGatewayUrl();
    forceExistingGatewayReconnect("app-update");
  }
}

/** One-shot "检查更新" mutation (also used by the notifier CTA). */
export function useAppUpdateCheck() {
  return useMutation<AppUpdateCheckResult>({
    // TanStack Query v5 removed `enabled` from mutation options; guard inside
    // the fn instead so a missing bridge fails the call rather than silently
    // no-oping (the managed-runtime panel hides the CTA when the bridge is
    // absent, so this only fires on a stale/half-updated webview).
    mutationFn: () => {
      if (!hasAppUpdateBridge()) {
        throw new Error("更新桥接不可用");
      }
      return window.hermesDesktop!.appUpdateCheck!();
    },
  });
}

/**
 * One-shot "更新" mutation — drives the whole unified update (backend install
 * + respawn + verify + frontend stage + relaunch). While in flight it keeps
 * the blocking overlay up (dashboard restarts rotate the session token) and
 * streams `app-update-progress` events into the overlay's log panel.
 */
export function useAppUpdateInstall() {
  const qc = useQueryClient();
  const setUpdating = useSetAtom(runtimeUpdatingAtom);

  // Register the progress listener once; it only appends when an app-update
  // is active. StrictMode double-mount is handled by the returned cleanup.
  useEffect(() => {
    if (!window.hermesDesktop?.onAppUpdateProgress) return;
    const unlisten = window.hermesDesktop.onAppUpdateProgress((payload) => {
      setUpdating((state) => {
        if (!state.active || state.mode !== "app-update") return state;
        return {
          ...state,
          progress: appendAppUpdateProgress(state, payload),
        };
      });
    });
    return unlisten;
  }, [setUpdating]);

  return useMutation<AppUpdateInstallResult>({
    mutationFn: () => window.hermesDesktop!.appUpdateInstall!(),
    onMutate: () => {
      setUpdating({ active: true, mode: "app-update", progress: [] });
    },
    onSettled: async () => {
      // Runs on success AND failure — a partial install can still have
      // restarted the dashboard, so always resync the rotated session token.
      await refreshDesktopGateway();
      await qc.invalidateQueries({ queryKey: RUNTIME_INFO_KEY });
      const fresh = qc.getQueryData<{ current?: { kernelVersion?: string } }>(
        RUNTIME_INFO_KEY,
      );
      recordRuntimeKernelVersion(fresh?.current?.kernelVersion);
      setUpdating({ active: false });
    },
  });
}
