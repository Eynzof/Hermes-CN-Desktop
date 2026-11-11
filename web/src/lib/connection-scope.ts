/** Keep session handles on the backend that issued them. Tokens may rotate. */
export function sessionStorageKey(key: string): string {
  const config = typeof window === "undefined" ? undefined : window.__HERMES_RUNTIME__;
  const mode = config?.connectionMode ?? "managed";
  // Preserve existing managed-session state and its per-profile native store.
  if (mode === "managed") return key;
  const target = config?.dashboardApiBaseUrl ?? config?.apiBaseUrl;
  const address = target ? new URL(target) : undefined;
  const identity = address
    ? `${address.origin}${address.pathname.replace(/\/+$/, "")}`
    : "unknown";
  return `${key}::${mode}:${encodeURIComponent(identity)}`;
}
