import { useQuery } from "@tanstack/react-query";
import { fetchJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { StatusResponse } from "@hermes/protocol";

export function useStatus() {
  const profile = useActiveProfileName();
  return useQuery<StatusResponse>({
    queryKey: ["status", profile],
    queryFn: ({ signal }) => fetchJSON("/api/status", { signal }, StatusResponse),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}
