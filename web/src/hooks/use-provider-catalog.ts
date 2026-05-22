import { useState, useEffect } from "react";
import {
  BUILTIN_PROVIDER_CATALOG,
  mergeProviderCatalog,
  fetchRemoteProviderCatalog,
  type ProviderCatalog,
} from "@/lib/provider-catalog";

// Single source of truth for the provider catalog. Today this just hands
// back the built-in constant + optionally merges a remote refresh on
// demand. When issue #54 lands (cloud-hosted catalog), this hook is the
// only place that needs to learn how to read the remote source, kick off
// the SWR fetch, and cache to the UI store — every other component that
// uses providers/models can stay as-is.
//
// Why a hook (vs. importing the constant directly): when remote catalog
// arrives, consumers will need to re-render as it refreshes. Pulling them
// through this hook now lets us add that subscription later without
// changing call sites.

interface UseProviderCatalogResult {
  catalog: ProviderCatalog;
  /** True while a remote refresh is in flight. Always false until the
   * remote URL is wired up. */
  refreshing: boolean;
  /** Last refresh status message (success or failure). Empty when idle. */
  message: string;
  /** Trigger a remote pull. No-op when VITE_HERMES_PROVIDER_CATALOG_URL is
   * unset — callers can still wire it to a button without checking config. */
  refresh: () => Promise<void>;
}

export function useProviderCatalog(): UseProviderCatalogResult {
  const [catalog, setCatalog] = useState<ProviderCatalog>(BUILTIN_PROVIDER_CATALOG);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = async () => {
    const url = import.meta.env.VITE_HERMES_PROVIDER_CATALOG_URL;
    if (!url) {
      setCatalog(BUILTIN_PROVIDER_CATALOG);
      setMessage(`当前使用内置预设 ${BUILTIN_PROVIDER_CATALOG.version}`);
      return;
    }

    setRefreshing(true);
    try {
      const remote = await fetchRemoteProviderCatalog(url);
      setCatalog(mergeProviderCatalog(BUILTIN_PROVIDER_CATALOG, remote));
      setMessage(`已刷新预设 ${remote.version}`);
    } catch (error) {
      setCatalog(BUILTIN_PROVIDER_CATALOG);
      setMessage(error instanceof Error ? error.message : "刷新失败，已回退内置预设");
    } finally {
      setRefreshing(false);
    }
  };

  // Auto-refresh once on mount when a remote URL is configured. Failures
  // fall through silently to the built-in catalog (no toast / no spinner
  // shown to the user) — the manual "刷新预设" button surfaces errors.
  useEffect(() => {
    const url = import.meta.env.VITE_HERMES_PROVIDER_CATALOG_URL;
    if (!url) return;
    void refresh();
    // intentionally only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { catalog, refreshing, message, refresh };
}
