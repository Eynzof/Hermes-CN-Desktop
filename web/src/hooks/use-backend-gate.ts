import { useEffect, useState } from "react";
import { runtime } from "@/lib/runtime";
import type {
  ManagedRuntimeDesiredState,
  ManagedRuntimeLifecycleState,
} from "@hermes/protocol";

/**
 * 启动门禁：把「后端未就绪」细分为「正在拉起」与「真离线」。
 * managed runtime 安装/启动期间返回 booting（显示加载屏），只有确认
 * 真离线（用户停用/已卸载/启动失败/外部连接不可达）才落到 OfflineShell。
 */
export type BackendGate = "booting" | "offline" | "ready";

const BOOTING_LIFECYCLES: ReadonlySet<ManagedRuntimeLifecycleState> = new Set([
  "installing",
  "starting",
]);

/** desiredState=running 但 lifecycle 长时间不活跃时的兜底超时（90s）。 */
const STALE_BOOT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 3_000;

function gateFromControl(
  backendReady: boolean,
  desiredState: ManagedRuntimeDesiredState | undefined,
  lifecycleState: ManagedRuntimeLifecycleState | undefined,
  staleTimedOut: boolean,
): BackendGate {
  if (backendReady) return "ready";
  if (lifecycleState && BOOTING_LIFECYCLES.has(lifecycleState)) return "booting";
  if (lifecycleState === "error") return "offline";
  if (desiredState === "running") return staleTimedOut ? "offline" : "booting";
  return "offline";
}

function initialGate(): BackendGate {
  return gateFromControl(
    runtime.isBackendReady(),
    runtime.getManagedRuntimeDesiredState(),
    runtime.getManagedRuntimeLifecycleState(),
    false,
  );
}

export function useBackendGate(): BackendGate {
  const [gate, setGate] = useState<BackendGate>(initialGate);

  useEffect(() => {
    if (gate === "ready") return;
    let stopped = false;
    let elapsed = 0;
    const timer = window.setInterval(() => {
      if (stopped) return;
      elapsed += POLL_INTERVAL_MS;
      void (async () => {
        try {
          const bridge = window.hermesDesktop;
          if (!bridge?.getDesktopControlState) return;
          const result = await bridge.getDesktopControlState();
          runtime.applyRuntimeControlResult(result);
          if (stopped) return;
          const next = gateFromControl(
            result.backendReady,
            result.desiredState,
            result.lifecycleState,
            elapsed >= STALE_BOOT_TIMEOUT_MS,
          );
          setGate(next);
        } catch {
          // 控制状态暂不可读：维持当前门禁，下个周期再试
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [gate]);

  return gate;
}
