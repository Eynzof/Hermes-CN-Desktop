import { useQuery } from "@tanstack/react-query";
import { ProviderModelsListResult } from "@hermes/protocol";

export interface UseProviderModelsResult {
  models: string[];
  fetchedAt: number;
}

export type ListProviderModelsFn = (params: {
  provider: string;
  base_url?: string;
  api_key?: string;
  /** "anthropic_messages" 让后端用 Anthropic 协议（x-api-key）列模型。 */
  api_mode?: string;
}) => Promise<ProviderModelsListResult>;

/**
 * Normalize a `provider.models` RPC result into a sorted, de-duped id list,
 * throwing the backend's error so TanStack Query surfaces it as a failure.
 * Pure (no React) so it stays unit-testable without rendering the hook.
 */
export function selectProviderModelIds(result: ProviderModelsListResult): string[] {
  if (!result.ok) {
    throw new Error(result.error ?? "模型列表获取失败");
  }
  const ids = result.models.filter((id) => id.length > 0);
  return Array.from(new Set(ids)).sort();
}

/**
 * Fetch a provider's model list through the gateway `provider.models` RPC
 * rather than the desktop `external_request` proxy. The backend has no
 * external-request SSRF guard, so a self-hosted provider on a LAN IP (e.g.
 * http://192.168.x.x:11434/v1) is reachable, and the web shell sidesteps the
 * browser CORS that blocked a direct fetch.
 */
export function useProviderModels(
  provider: string,
  baseUrl: string,
  apiKey: string | undefined,
  listModels: ListProviderModelsFn,
  apiMode?: string,
) {
  return useQuery<UseProviderModelsResult>({
    queryKey: ["provider-models", provider, baseUrl],
    queryFn: async () => {
      const result = await listModels({ provider, base_url: baseUrl, api_key: apiKey, api_mode: apiMode });
      return { models: selectProviderModelIds(result), fetchedAt: Date.now() };
    },
    enabled: false,
    staleTime: 15 * 60 * 1000,
    retry: false,
  });
}
