import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, postJSON, putJSON, raceAbort } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import type { MemoryInfo, MemoryMutationResult } from "@/lib/runtime";
import {
  MemoryProviderConfigMutationResponse,
  MemoryProviderConfigResponse,
  MemoryProviderRuntimeStatusResponse,
  MemoryProvidersResponse,
  MemoryProviderSetupResponse,
  MutationOkResponse,
  type MemoryProviderListItem,
} from "@hermes/protocol";

export const VISIBLE_MEMORY_PROVIDERS = ["openviking", "hindsight"] as const;
export type VisibleMemoryProvider = (typeof VISIBLE_MEMORY_PROVIDERS)[number];

export interface MemoryProviderOption extends MemoryProviderListItem {
  name: VisibleMemoryProvider;
}

export interface MemoryProvidersState {
  active: string;
  options: MemoryProviderOption[];
}

export function toMemoryProvidersState(data: MemoryProvidersResponse): MemoryProvidersState {
  return {
    active: data.active ?? "",
    options: VISIBLE_MEMORY_PROVIDERS.map((name) => {
      const provider = (data.providers ?? []).find((item) => item.name === name);
      return {
        name,
        description: provider?.description ?? "",
        available: provider?.available ?? false,
        configured: provider?.configured ?? false,
        status: provider?.status ?? "",
        missing: provider?.missing ?? false,
        setup: provider?.setup,
      };
    }),
  };
}

export function memoryProviderConfigPayload(values: Record<string, unknown>) {
  return { values, activate: false as const };
}

export function memoryProviderConfigQueryKey(profile: string, provider: VisibleMemoryProvider) {
  return ["memory-provider-config", profile, provider] as const;
}

export function memoryProviderStatusQueryKey(profile: string, provider: VisibleMemoryProvider) {
  return ["memory-provider-status", profile, provider] as const;
}

export async function saveMemoryProviderConfig(
  provider: VisibleMemoryProvider,
  values: Record<string, unknown>,
) {
  return putJSON(
    `/api/memory/providers/${encodeURIComponent(provider)}/config`,
    memoryProviderConfigPayload(values),
    MemoryProviderConfigMutationResponse,
  );
}

function ensureMemoryBridge() {
  const api = window.hermesDesktop;
  if (!api?.readMemory) {
    throw new Error("当前记忆页需要在 Hermes 桌面端中打开。浏览器预览暂不支持直接读写本地 memories 文件。");
  }
  return api;
}

export function useMemory() {
  const profile = useActiveProfileName();
  return useQuery<MemoryInfo>({
    queryKey: ["memory", profile],
    queryFn: ({ signal }) => raceAbort(ensureMemoryBridge().readMemory!(), signal),
  });
}

export function useAddMemoryEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (content: string): Promise<MemoryMutationResult> => {
      const result = await ensureMemoryBridge().addMemoryEntry!(content);
      if (!result.success) throw new Error(result.error || "添加记忆失败");
      return result;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memory"] }),
  });
}

export function useUpdateMemoryEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ index, content }: { index: number; content: string }): Promise<MemoryMutationResult> => {
      const result = await ensureMemoryBridge().updateMemoryEntry!(index, content);
      if (!result.success) throw new Error(result.error || "更新记忆失败");
      return result;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memory"] }),
  });
}

export function useRemoveMemoryEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (index: number): Promise<boolean> => ensureMemoryBridge().removeMemoryEntry!(index),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memory"] }),
  });
}

export function useSaveUserProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (content: string): Promise<MemoryMutationResult> => {
      const result = await ensureMemoryBridge().writeUserProfile!(content);
      if (!result.success) throw new Error(result.error || "保存用户画像失败");
      return result;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memory"] }),
  });
}

export function useMemoryProviders(options: { enabled?: boolean } = {}) {
  const profile = useActiveProfileName();
  return useQuery<MemoryProvidersState>({
    queryKey: ["memory-providers", profile],
    queryFn: async ({ signal }) => {
      const data = await fetchJSON("/api/memory", { signal }, MemoryProvidersResponse);
      return toMemoryProvidersState(data);
    },
    staleTime: 30_000,
    enabled: options.enabled,
  });
}

export function useMemoryProviderConfig(provider: VisibleMemoryProvider, enabled: boolean) {
  const profile = useActiveProfileName();
  return useQuery({
    queryKey: memoryProviderConfigQueryKey(profile, provider),
    queryFn: ({ signal }) => fetchJSON(
      `/api/memory/providers/${encodeURIComponent(provider)}/config`,
      { signal },
      MemoryProviderConfigResponse,
    ),
    enabled,
    staleTime: 15_000,
  });
}

export function useMemoryProviderStatus(provider: VisibleMemoryProvider, enabled: boolean) {
  const profile = useActiveProfileName();
  return useQuery({
    queryKey: memoryProviderStatusQueryKey(profile, provider),
    queryFn: ({ signal }) => fetchJSON(
      `/api/memory/providers/${encodeURIComponent(provider)}/status`,
      { signal },
      MemoryProviderRuntimeStatusResponse,
    ),
    enabled,
    staleTime: 10_000,
    refetchInterval: enabled ? 30_000 : false,
    refetchOnWindowFocus: true,
  });
}

export function useSaveMemoryProviderConfig() {
  const qc = useQueryClient();
  const profile = useActiveProfileName();
  return useMutation({
    mutationFn: ({ provider, values }: { provider: VisibleMemoryProvider; values: Record<string, unknown> }) =>
      saveMemoryProviderConfig(provider, values),
    onSuccess: (_result, input) => {
      qc.invalidateQueries({ queryKey: ["memory-provider-config", profile, input.provider] });
      qc.invalidateQueries({ queryKey: ["memory-provider-status", profile, input.provider] });
      qc.invalidateQueries({ queryKey: ["memory-providers", profile] });
    },
  });
}

export function useSetupMemoryProvider() {
  const qc = useQueryClient();
  const profile = useActiveProfileName();
  return useMutation({
    mutationFn: (provider: VisibleMemoryProvider) => postJSON(
      `/api/memory/providers/${encodeURIComponent(provider)}/setup`,
      { values: {} },
      MemoryProviderSetupResponse,
    ),
    onSuccess: (_result, provider) => {
      qc.invalidateQueries({ queryKey: ["memory-provider-config", profile, provider] });
      qc.invalidateQueries({ queryKey: ["memory-provider-status", profile, provider] });
      qc.invalidateQueries({ queryKey: ["memory-providers", profile] });
    },
  });
}

export function useSetMemoryProvider() {
  const qc = useQueryClient();
  const profile = useActiveProfileName();
  return useMutation({
    mutationFn: (provider: string) =>
      putJSON("/api/memory/provider", { provider }, MutationOkResponse),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["memory-providers", profile] });
      qc.invalidateQueries({ queryKey: ["memory-provider-status", profile] });
      qc.invalidateQueries({ queryKey: ["config"] });
    },
  });
}
