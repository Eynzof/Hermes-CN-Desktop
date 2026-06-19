import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { runtime } from "@/lib/runtime";
import { raceAbort } from "@/lib/transport";
import { forceExistingGatewayReconnect } from "@/lib/gateway-client";
import { reloadUiStore } from "@/lib/ui-store";
import { profileSwitchingAtom } from "@/stores/ui";
import { PROFILE_AWARE_QUERY_KEYS } from "@/hooks/use-profiles";
import type { YoloModeStatus } from "@hermes/protocol";

/** YOLO mode is a desktop-only feature: it depends on (re)launching the managed
 * runtime, which only the Tauri/Electron shell can do. Attached local/remote
 * agents decide their own approval policy, so they report unsupported. */
export function isYoloModeSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.hermesDesktop?.setYoloMode &&
    runtime.isManaged()
  );
}

export function useYoloMode() {
  return useQuery<YoloModeStatus>({
    queryKey: ["yolo-mode"],
    enabled: isYoloModeSupported(),
    queryFn: ({ signal }) => raceAbort(window.hermesDesktop!.getYoloMode!(), signal),
    staleTime: 30_000,
  });
}

export function useSetYoloMode() {
  const qc = useQueryClient();
  const setSwitching = useSetAtom(profileSwitchingAtom);
  return useMutation<{ enabled: boolean; restarted: boolean }, Error, boolean>({
    mutationFn: async (enabled: boolean) => {
      if (!window.hermesDesktop?.setYoloMode) {
        throw new Error("当前环境不支持 YOLO 模式");
      }
      // Restarting the dashboard drops every in-flight REST/WS request. Reuse
      // the profile-switch overlay so the user sees a clean "重启中" state
      // instead of a burst of 401/network errors.
      setSwitching({
        active: true,
        title: enabled ? "正在开启 YOLO 模式…" : "正在关闭 YOLO 模式…",
        body: "桌面端正在重启内核以使设置生效，通常 5-15 秒，请稍候。",
      });
      try {
        const result = await window.hermesDesktop.setYoloMode({ enabled });
        if (!result.ok) {
          throw new Error(result.error || "设置 YOLO 模式失败");
        }
        if (result.restarted) {
          runtime.applyYoloRestartResult(result);
          forceExistingGatewayReconnect("yolo-restart");
        }
        return { enabled: result.enabled, restarted: result.restarted };
      } finally {
        setSwitching({ active: false });
      }
    },
    onSuccess: async () => {
      // The runtime restarted (same HERMES_HOME, rotated session token), just
      // like a profile switch — reconnect the UI store and refetch every
      // profile-aware query that was talking to the now-dead process.
      await reloadUiStore();
      qc.invalidateQueries({ queryKey: ["yolo-mode"] });
      for (const key of PROFILE_AWARE_QUERY_KEYS) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: () => {
      // A restart may have failed after the preference was already persisted.
      // Refetch so the toggle reflects the saved value (and the "applies on
      // restart" hint) instead of snapping back to a stale position.
      qc.invalidateQueries({ queryKey: ["yolo-mode"] });
    },
  });
}
