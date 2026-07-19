import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJSON, putJSON, raceAbort } from "@/lib/transport";
import { useActiveProfileName } from "@/hooks/use-profiles";
import type { MemoryInfo, MemoryMutationResult } from "@/lib/runtime";
import { MutationOkResponse } from "@hermes/protocol";

export interface MemoryProviderOption {
  name: string;
  description: string;
}

export interface MemoryProvidersState {
  active: string;
  options: MemoryProviderOption[];
}

/** Response shape from GET /api/memory (the correct endpoint for runtime memory state). */
interface MemoryStatusResponse {
  active: string;
  providers: Array<{
    name: string;
    description: string;
    available: boolean;
    missing?: boolean;
  }>;
  builtin_files: Record<string, number>;
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
      const data = await fetchJSON<MemoryStatusResponse>("/api/memory", { signal });
      return {
        active: data.active ?? "",
        options: (data.providers ?? []).map((p) => ({
          name: p.name,
          description: p.description ?? "",
        })),
      };
    },
    staleTime: 30_000,
    enabled: options.enabled,
  });
}

export function useSetMemoryProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) =>
      putJSON("/api/memory/provider", { provider }, MutationOkResponse),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["memory-providers"] });
      qc.invalidateQueries({ queryKey: ["config"] });
    },
  });
}
