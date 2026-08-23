import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, putJSON } from "@/lib/transport";
import { invalidateModelOptionsCache } from "@/lib/model-options-cache";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { runtime } from "@/lib/runtime";
import {
  ConfigResponse,
  ConfigSchemaResponse,
  ConfigUpdateRequest,
  ModelInfo,
  MutationOkResponse,
} from "@hermes/protocol";

export function buildConfigUpdateRequest(
  config: Record<string, any>,
  deletedPaths?: string[],
): ConfigUpdateRequest {
  return ConfigUpdateRequest.parse(
    deletedPaths?.length ? { config, deleted_paths: deletedPaths } : { config },
  );
}

/** 带显式删除的保存输入：config 为删除后的完整配置，deletedPaths 是被删 key 的
 * 点分路径。后端深合并无法表达删除（P-042），必须显式声明。 */
export interface SaveConfigDeletion {
  config: Record<string, any>;
  deletedPaths: string[];
}

function isSaveConfigDeletion(
  input: Record<string, any> | SaveConfigDeletion,
): input is SaveConfigDeletion {
  return (
    Array.isArray((input as SaveConfigDeletion).deletedPaths)
    && typeof (input as SaveConfigDeletion).config === "object"
    && (input as SaveConfigDeletion).config !== null
  );
}

export function useConfig() {
  const profile = useActiveProfileName();
  return useQuery<Record<string, any>>({
    queryKey: ["config", profile],
    queryFn: ({ signal }) => fetchJSON("/api/config", { signal }, ConfigResponse),
    enabled: runtime.isBackendReady(),
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
    enabled: runtime.isBackendReady(),
    staleTime: 5 * 60_000,
  });
}

export function useModelInfo() {
  const profile = useActiveProfileName();
  return useQuery<ModelInfo>({
    queryKey: ["model-info", profile],
    queryFn: ({ signal }) => fetchJSON("/api/model/info", { signal }, ModelInfo),
    enabled: runtime.isBackendReady(),
    // Model metadata changes via config saves (which invalidate this) or an
    // explicit model switch (via CLI or WS event); poll every 15s so the UI
    // catches CLI switches even if the WebSocket event is missed.
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useSaveConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, any> | SaveConfigDeletion) => {
      const config = isSaveConfigDeletion(input) ? input.config : input;
      const deletedPaths = isSaveConfigDeletion(input) ? input.deletedPaths : undefined;
      return putJSON(
        "/api/config",
        buildConfigUpdateRequest(config, deletedPaths),
        MutationOkResponse,
      );
    },
    onSuccess: () => {
      invalidateModelOptionsCache();
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["model-info"] });
      // 配置保存会改变已配置供应商集合（新增/删除/改密钥），工作台
      // 「切换模型」的列表来自 /api/model/options（React Query 缓存 5 分钟），
      // 必须在这里一并失效，否则保存后工作台仍展示旧的（甚至已失效的）配置。
      qc.invalidateQueries({ queryKey: ["model-options"] });
    },
  });
}
