import { useEffect } from "react";

export interface WanderMemoryRouteLifecycleProps {
  active: boolean;
}

/**
 * Owns the live MemOS singleton for as long as the user stays inside the
 * Wander route group. The client module remains lazy on non-Wander routes.
 */
export function WanderMemoryRouteLifecycle({ active }: WanderMemoryRouteLifecycleProps) {
  useEffect(() => {
    if (!active) return;
    return () => {
      void import("@/lib/wander-memory/client").then(({ disposeWanderMemoryClient }) => {
        disposeWanderMemoryClient();
      });
    };
  }, [active]);

  return null;
}
