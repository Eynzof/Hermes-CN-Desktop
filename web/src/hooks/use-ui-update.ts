import { useMutation } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import type {
  UiInstallUpdateResult,
  UiUpdateCheckResult,
  UiUpdateReadyPayload,
} from "@hermes/protocol";
import { runtime } from "@/lib/runtime";
import { runtimeUpdatingAtom } from "@/stores/ui";

// Track B UI hot update (custom `hermesui:` scheme): signed web-dist zip swap.
// Unlike the kernel runtime update this never restarts the dashboard — the
// Rust side emits `ui-update-ready` and reloads the window itself. These hooks
// raise the same blocking overlay (mode "ui-update") around the IPC call so
// the reload flash never surfaces a half-swapped UI.

/** Overlay state raised on mutation start (pure, unit-tested). */
export function uiUpdatingActivePayload(): { active: true; mode: "ui-update" } {
  return { active: true, mode: "ui-update" };
}

/** Overlay state restored on mutation settle — success AND failure (pure). */
export function uiUpdatingSettledPayload(): { active: false } {
  return { active: false };
}

/** True when the overlay should render the ui-update card (pure). */
export function isUiUpdateOverlayActive(
  active: boolean,
  mode: string | undefined,
): boolean {
  return active && mode === "ui-update";
}

export function useUiUpdateCheck() {
  return useMutation<UiUpdateCheckResult>({
    mutationFn: () => window.hermesDesktop!.uiCheckUpdate!(),
  });
}

export function useUiUpdateInstall() {
  const setUpdating = useSetAtom(runtimeUpdatingAtom);
  return useMutation<UiInstallUpdateResult>({
    mutationFn: () => window.hermesDesktop!.uiInstallUpdate!(),
    onMutate: () => {
      setUpdating(uiUpdatingActivePayload());
    },
    onSettled: () => {
      // Runs on success AND failure; the window may already be reloading.
      setUpdating(uiUpdatingSettledPayload());
    },
  });
}

export function useUiUpdateRollback() {
  const setUpdating = useSetAtom(runtimeUpdatingAtom);
  return useMutation<UiInstallUpdateResult>({
    mutationFn: () => window.hermesDesktop!.uiRollback!(),
    onMutate: () => {
      setUpdating(uiUpdatingActivePayload());
    },
    onSettled: () => {
      setUpdating(uiUpdatingSettledPayload());
    },
  });
}

/**
 * Subscribe to `ui-update-ready` and reload the page as a belt-and-suspenders
 * fallback (the Rust side already reloads the webview; this covers the case
 * where that reload is raced or dropped). Returns an unsubscribe function.
 * The optional `reload` override makes the behavior unit-testable.
 */
export function listenForUiUpdateReady(
  onReady?: (payload: UiUpdateReadyPayload) => void,
  reload: (payload: UiUpdateReadyPayload) => void = (payload) => {
    window.location.reload();
    void payload;
  },
): () => void {
  if (
    typeof window === "undefined" ||
    runtime.platform === "web" ||
    !window.hermesDesktop?.onUiUpdateReady
  ) {
    return () => {};
  }
  return window.hermesDesktop.onUiUpdateReady((payload) => {
    onReady?.(payload);
    reload(payload);
  });
}
