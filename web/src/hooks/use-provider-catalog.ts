import { useState, useEffect } from "react";
import {
  BUILTIN_PROVIDER_CATALOG,
  mergeProviderCatalog,
  fetchRemoteProviderCatalog,
  type ProviderCatalog,
} from "@/lib/provider-catalog";

// Single source of truth for the provider catalog: built-in constant as the
// floor, merged with the remotely distributed provider-catalog.json (landing
// 站点 Cloudflare Pages 静态分发，与 model-catalog.json 同一套模式)。远端
// 更新覆盖合作伙伴邀请链接、推广徽章与新增供应商 —— 不需要桌面端发版。
// 合并层拒绝覆盖内置供应商的连线配置（baseUrl 等），见 mergeProviderCatalog。
//
// Why a hook (vs. importing the constant directly): consumers re-render as
// the remote catalog lands after the on-mount fetch.

/** 远端目录默认源。构建时可用 VITE_HERMES_PROVIDER_CATALOG_URL 覆盖。 */
const DEFAULT_PROVIDER_CATALOG_URL =
  "https://desktop.hermesagent.org.cn/api/provider-catalog.json";

function resolveCatalogUrl(): string {
  const override = import.meta.env.VITE_HERMES_PROVIDER_CATALOG_URL;
  return typeof override === "string" && override.trim()
    ? override.trim()
    : DEFAULT_PROVIDER_CATALOG_URL;
}

interface UseProviderCatalogResult {
  catalog: ProviderCatalog;
  /** True while a remote refresh is in flight. */
  refreshing: boolean;
  /** Last refresh status message (success or failure). Empty when idle. */
  message: string;
  /** Trigger a remote pull; failures fall back to the built-in catalog. */
  refresh: () => Promise<void>;
}

export function useProviderCatalog(): UseProviderCatalogResult {
  const [catalog, setCatalog] = useState<ProviderCatalog>(BUILTIN_PROVIDER_CATALOG);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = async () => {
    setRefreshing(true);
    try {
      const remote = await fetchRemoteProviderCatalog(resolveCatalogUrl());
      setCatalog(mergeProviderCatalog(BUILTIN_PROVIDER_CATALOG, remote));
      setMessage(`已刷新预设 ${remote.version}`);
    } catch (error) {
      setCatalog(BUILTIN_PROVIDER_CATALOG);
      setMessage(error instanceof Error ? error.message : "刷新失败，已回退内置预设");
    } finally {
      setRefreshing(false);
    }
  };

  // Auto-refresh once on mount. Failures fall through silently to the
  // built-in catalog (no toast / no spinner shown to the user) — the manual
  // "刷新预设" button surfaces errors.
  useEffect(() => {
    void refresh();
    // intentionally only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { catalog, refreshing, message, refresh };
}
