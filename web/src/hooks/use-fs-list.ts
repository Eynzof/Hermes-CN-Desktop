import { useQuery } from "@tanstack/react-query";
import { fetchJSON } from "@/lib/transport";
import { FsListResponse } from "@hermes/protocol";

export function useFsList(path: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["fs-list", path],
    queryFn: ({ signal }) =>
      fetchJSON(`/api/fs/list?path=${encodeURIComponent(path)}`, { signal }, FsListResponse),
    enabled: options?.enabled ?? true,
    staleTime: 0,
    refetchOnWindowFocus: false,
    gcTime: 30_000,
  });
}
