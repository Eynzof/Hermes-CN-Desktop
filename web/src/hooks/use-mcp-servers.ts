import { useQuery } from "@tanstack/react-query";
import { fetchJSON } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  McpServersFullResponse,
  type McpServersResponse,
} from "@hermes/protocol";

export async function fetchMcpServersSummary(signal?: AbortSignal): Promise<McpServersResponse> {
  const response = await fetchJSON(
    "/api/mcp/servers",
    { signal },
    McpServersFullResponse,
  );
  const servers = response.servers.map(({ name, enabled }) => ({ name, enabled }));

  return {
    summary: {
      total: servers.length,
      enabled: servers.filter((server) => server.enabled).length,
    },
    servers,
  };
}

export function useMcpServers() {
  const profile = useActiveProfileName();
  return useQuery<McpServersResponse>({
    queryKey: ["mcp-servers", profile],
    queryFn: ({ signal }) => fetchMcpServersSummary(signal),
    staleTime: 60_000,
  });
}
