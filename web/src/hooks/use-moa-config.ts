import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, putJSON } from "@/lib/transport";
import { invalidateModelOptionsCache } from "@/lib/model-options-cache";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { inspectMoaYaml } from "@/lib/moa-config-source";
import { isLoopbackHttpOrigin } from "@/lib/browser-companion";
import { MoaConfigResponse } from "@hermes/protocol";
import { forgetLastUsedModel, readLastUsedModel } from "@/lib/last-used-model";

// MoA（Mixture of Agents）预设配置。对齐官方桌面端（Core apps/desktop
// model-settings）：编辑器读写 REST /api/model/moa，preset 列表在模型选择器里
// 则来自 gateway model.options 的虚拟 `moa` provider 行——两条数据路径。
//
function localSourceOrigin(): string | undefined {
  const rt = window.__HERMES_RUNTIME__;
  const origin = rt?.dashboardApiBaseUrl || rt?.apiBaseUrl;
  if (rt?.platform === "tauri" && (rt.connectionMode === "local" || rt.connectionMode === "managed") &&
      origin && isLoopbackHttpOrigin(origin)) return origin;
}

export function useMoaSource(enabled = true) {
  const profile = useActiveProfileName();
  const origin = localSourceOrigin();
  return useQuery({
    queryKey: ["moa-source", origin, profile],
    enabled: enabled && Boolean(origin),
    queryFn: async ({ signal }) => {
      if (!origin || localSourceOrigin() !== origin) return null;
      const { current } = await fetchJSON<{ current: string }>("/api/profiles/active", { signal });
      if (current !== profile || localSourceOrigin() !== origin) return null;
      // "current" uses the running dashboard's actual home, including portable installations.
      const { yaml } = await fetchJSON<{ yaml: string }>("/api/config/raw?profile=current", { signal });
      return localSourceOrigin() === origin ? inspectMoaYaml(yaml) : null;
    },
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

export function useMoaConfig(enabled = true) {
  const profile = useActiveProfileName();
  return useQuery<MoaConfigResponse>({
    queryKey: ["moa-config", profile],
    enabled,
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
  const profile = useActiveProfileName();
  return useMutation({
    mutationFn: (config: MoaConfigResponse) =>
      putJSON("/api/model/moa", config, MoaConfigResponse),
    onSuccess: (saved) => {
      const selected = readLastUsedModel();
      if (selected?.provider === "moa" && !saved.presets[selected.model]) {
        forgetLastUsedModel();
      }
      // 预设增删会改变模型选择器里 moa 虚拟 provider 的模型列表：
      // 既要清 gateway RPC 的 5 分钟模块缓存，也要触发 React Query 重取。
      invalidateModelOptionsCache();
      qc.invalidateQueries({ queryKey: ["model-options"] });
      qc.setQueryData(["moa-config", profile], saved);
      void qc.invalidateQueries({ queryKey: ["moa-source"] });
    },
  });
}
