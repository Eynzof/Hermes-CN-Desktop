import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodingAgentsCheckResult } from "@hermes/protocol";
import { runtime } from "@/lib/runtime";
import { raceAbort } from "@/lib/transport";

const CODING_AGENTS_CHECK_KEY = ["desktop-coding-agents-check"] as const;

function hasCodingAgentsBridge(): boolean {
  return (
    typeof window !== "undefined" &&
    runtime.platform !== "web" &&
    Boolean(window.hermesDesktop?.codingAgentsCheck)
  );
}

/** 编程Agent CLI（Claude Code / Codex）检测；比照 use-environment-check。 */
export function useCodingAgentsCheck() {
  return useQuery<CodingAgentsCheckResult>({
    queryKey: CODING_AGENTS_CHECK_KEY,
    queryFn: ({ signal }) => raceAbort(window.hermesDesktop!.codingAgentsCheck!(), signal),
    enabled: hasCodingAgentsBridge(),
    staleTime: 10_000,
    refetchInterval: 60_000,
  });
}

export function useRefreshCodingAgents() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: CODING_AGENTS_CHECK_KEY });
}
