import { useQuery } from "@tanstack/react-query";
import { fetchJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { StatusResponse } from "@hermes/protocol";
import { runtime } from "@/lib/runtime";

export function useStatus() {
  const profile = useActiveProfileName();
  return useQuery<StatusResponse>({
    queryKey: ["status", profile],
    queryFn: ({ signal }) => fetchJSON("/api/status", { signal }, StatusResponse),
    enabled: runtime.isBackendReady(),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}
