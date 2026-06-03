import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { runtime } from "@/lib/runtime";
import { reloadUiStore } from "@/lib/ui-store";
import { profileSwitchingAtom } from "@/stores/ui";
import type { YoloModeStatus } from "@hermes/protocol";

/** YOLO mode is a desktop-only feature: it depends on (re)launching the managed
 * runtime, which only the Tauri/Electron shell can do. */
export function isYoloModeSupported(): boolean {
  return typeof window !== "undefined" && !!window.hermesDesktop?.setYoloMode;
}

export function useYoloMode() {
  return useQuery<YoloModeStatus>({
    queryKey: ["yolo-mode"],
    enabled: isYoloModeSupported(),
    queryFn: async () => {
      const status = await window.hermesDesktop!.getYoloMode!();
      return status;
    },
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
      // Restarting the dashboard drops every in-flight REST/SSE request. Reuse
      // the profile-switch overlay so the user sees a clean "重启中" state
      // instead of a burst of 401/network errors.
      setSwitching({
        active: true,
        title: enabled ? "正在开启 YOLO 模式…" : "正在关闭 YOLO 模式…",
        body: "桌面端正在重启内核以使设置生效，通常 2-3 秒，请稍候。",
      });
      try {
        const result = await window.hermesDesktop.setYoloMode({ enabled });
        if (!result.ok) {
          throw new Error(result.error || "设置 YOLO 模式失败");
        }
        if (result.restarted) {
          runtime.applyYoloRestartResult(result);
        }
        return { enabled: result.enabled, restarted: result.restarted };
      } finally {
        setSwitching({ active: false });
      }
    },
    onSuccess: async () => {
      // The runtime restarted: reconnect the gateway with the rotated token and
      // refresh status/profile-derived state.
      await reloadUiStore();
      qc.invalidateQueries({ queryKey: ["yolo-mode"] });
      qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
}
