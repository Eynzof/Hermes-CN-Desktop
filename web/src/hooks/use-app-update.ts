import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import type {
  AppUpdateCheckResult,
  AppUpdateDownloadResult,
  AppUpdateInstallResult,
  AppUpdateProgressPayload,
} from "@hermes/protocol";
import { runtime } from "@/lib/runtime";
import { runtimeUpdatingAtom } from "@/stores/ui";

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
    Boolean(
      window.hermesDesktop?.appUpdateCheck &&
      window.hermesDesktop?.appUpdateDownload &&
      window.hermesDesktop?.appUpdateInstall,
    )
  );
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

/** Download and verify the authorised package without starting the installer. */
export function useAppUpdateDownload() {
  const setUpdating = useSetAtom(runtimeUpdatingAtom);
  return useMutation<AppUpdateDownloadResult>({
    mutationFn: () => {
      if (!window.hermesDesktop?.appUpdateDownload) {
        throw new Error("当前版本不支持预下载更新包");
      }
      return window.hermesDesktop.appUpdateDownload();
    },
    onMutate: () => {
      setUpdating({ active: true, mode: "app-update", progress: [] });
    },
    onSettled: () => {
      setUpdating({ active: false });
    },
  });
}

/**
 * Apply a previously verified package. The Rust side rechecks rollout
 * authorisation before stopping the managed Runtime and starting the installer.
 */
export function useAppUpdateInstall() {
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
    mutationFn: () => {
      if (!window.hermesDesktop?.appUpdateInstall) throw new Error("更新桥接不可用");
      return window.hermesDesktop.appUpdateInstall();
    },
    onMutate: () => {
      setUpdating({ active: true, mode: "app-update", progress: [] });
    },
    onSettled: () => {
      setUpdating({ active: false });
    },
  });
}
