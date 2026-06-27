import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, putJSON } from "@/lib/transport";
import { invalidateModelOptionsCache } from "@/lib/model-options-cache";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  ConfigResponse,
  ConfigSchemaResponse,
  ConfigUpdateRequest,
  ModelInfo,
  MutationOkResponse,
} from "@hermes/protocol";

export function buildConfigUpdateRequest(config: Record<string, any>): ConfigUpdateRequest {
  return ConfigUpdateRequest.parse({ config });
}

export function useConfig() {
  const profile = useActiveProfileName();
  return useQuery<Record<string, any>>({
    queryKey: ["config", profile],
    queryFn: ({ signal }) => fetchJSON("/api/config", { signal }, ConfigResponse),
    // Config changes only via saves (which invalidate this query), so avoid the
    // focus-refetch storm that re-hits the Models page's backing endpoints.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useConfigSchema() {
  // schema 是上游 hermes-agent 代码里的 dataclass，与具体 profile 无关
  return useQuery<ConfigSchemaResponse>({
    queryKey: ["config-schema"],
    queryFn: ({ signal }) => fetchJSON("/api/config/schema", { signal }, ConfigSchemaResponse),
    staleTime: 5 * 60_000,
  });
}

export function useModelInfo() {
  const profile = useActiveProfileName();
  return useQuery<ModelInfo>({
    queryKey: ["model-info", profile],
    queryFn: ({ signal }) => fetchJSON("/api/model/info", { signal }, ModelInfo),
    // Model metadata changes via config saves (which invalidate this) or an
    // explicit model switch; no need to refetch on every window focus.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useSaveConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: Record<string, any>) =>
      putJSON("/api/config", buildConfigUpdateRequest(config), MutationOkResponse),
    onSuccess: () => {
      invalidateModelOptionsCache();
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["model-info"] });
    },
  });
}
