import { useQuery } from "@tanstack/react-query";
import { fetchJSON } from "@/lib/transport";
import { LogsResponse } from "@hermes/protocol";

export function useLogs(file = "agent", lines = 200, level?: string, component?: string) {
  return useQuery<LogsResponse>({
    queryKey: ["logs", file, lines, level, component],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ file, lines: String(lines) });
      if (level && level !== "ALL") params.set("level", level);
      if (component && component !== "all") params.set("component", component);
      return fetchJSON(`/api/logs?${params}`, { signal }, LogsResponse);
    },
    staleTime: 5_000,
  });
}
