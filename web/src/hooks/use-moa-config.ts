import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, putJSON } from "@/lib/transport";
import { invalidateModelOptionsCache } from "@/lib/model-options-cache";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { MoaConfigResponse } from "@hermes/protocol";

// MoA（Mixture of Agents）预设配置。对齐官方桌面端（Core apps/desktop
// model-settings）：编辑器读写 REST /api/model/moa，preset 列表在模型选择器里
// 则来自 gateway model.options 的虚拟 `moa` provider 行——两条数据路径。
//
// 注意：后端 PUT 的 MoaConfigPayload 只接受 reference_models / aggregator /
// 温度 / max_tokens / enabled；reference_max_tokens、fanout 等字段保存后会被
// 归一化回默认值。官方桌面端同样如此，属后端 payload 限制，非本端缺陷。

export function useMoaConfig() {
  const profile = useActiveProfileName();
  return useQuery<MoaConfigResponse>({
    queryKey: ["moa-config", profile],
    queryFn: ({ signal }) => fetchJSON("/api/model/moa", { signal }, MoaConfigResponse),
    // 只有保存会改变配置（保存后主动失效），避免窗口聚焦风暴。
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    // 老后端没有该端点：静默失败，由调用方决定隐藏还是提示。
    retry: 1,
  });
}

export function useSaveMoaConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: MoaConfigResponse) =>
      putJSON("/api/model/moa", config, MoaConfigResponse),
    onSuccess: (saved) => {
      // 预设增删会改变模型选择器里 moa 虚拟 provider 的模型列表：
      // 既要清 gateway RPC 的 5 分钟模块缓存，也要触发 React Query 重取。
      invalidateModelOptionsCache();
      qc.invalidateQueries({ queryKey: ["model-options"] });
      qc.setQueriesData({ queryKey: ["moa-config"] }, saved);
    },
  });
}
