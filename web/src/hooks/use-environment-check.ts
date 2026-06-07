import { useQuery } from "@tanstack/react-query";
import type { EnvironmentCheckResult } from "@hermes/protocol";
import { runtime } from "@/lib/runtime";
import { raceAbort } from "@/lib/transport";

const ENVIRONMENT_CHECK_KEY = ["desktop-environment-check"] as const;

function hasEnvironmentBridge(): boolean {
  return typeof window !== "undefined" &&
    runtime.platform !== "web" &&
    Boolean(window.hermesDesktop?.environmentCheck);
}

export function useEnvironmentCheck() {
  return useQuery<EnvironmentCheckResult>({
    queryKey: ENVIRONMENT_CHECK_KEY,
    queryFn: ({ signal }) => raceAbort(window.hermesDesktop!.environmentCheck!(), signal),
    enabled: hasEnvironmentBridge(),
    staleTime: 10_000,
    refetchInterval: 60_000,
  });
}
