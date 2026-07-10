// Re-login banner for gated remote gateways. Surfaces when the remote OAuth
// session expires — signalled by either the Tauri `connection-auth-expired`
// event (from REST 401 / WS mint 401) or the gateway client's
// `gateway.auth_required` event (from a 4401/4403 WS close). Offers a one-tap
// re-login that reuses the existing OAuth window / cookie session, then forces
// the gateway to reconnect.
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Alert, Button } from "@hermes/shared-ui";
import {
  notifyConnectionAuthRestored,
  onConnectionAuthRestored,
} from "@/lib/connection-auth-events";
import { forceExistingGatewayReconnect, getGatewayClient } from "@/lib/gateway-client";

export function ConnectionAuthBanner() {
  const [expired, setExpired] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const desktop = typeof window !== "undefined" ? window.hermesDesktop : undefined;

  useEffect(() => {
    // Tauri event: REST 401 / WS mint 401 carry the gateway base URL.
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ baseUrl?: string }>("connection-auth-expired", (event) => {
          setBaseUrl(event.payload?.baseUrl ?? null);
          setExpired(true);
        }),
      )
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    // Gateway event: a 4401/4403 WS close (no base URL — reuse the saved one).
    const off = getGatewayClient().on("gateway.auth_required", () => setExpired(true));
    // Settings can complete either an OAuth-window or password-provider login.
    // Clear the global banner and release gateway-client's auth suspension for
    // both paths instead of requiring another save/reload cycle.
    const offRestored = onConnectionAuthRestored(() => {
      setExpired(false);
      forceExistingGatewayReconnect("oauth-relogin");
    });

    return () => {
      unlisten?.();
      off?.();
      offRestored();
    };
  }, []);

  if (!expired) return null;

  const handleRelogin = async () => {
    setBusy(true);
    try {
      let url = baseUrl;
      if (!url) {
        url = (await desktop?.getConnectionConfig?.())?.remoteUrl ?? null;
      }
      if (url && desktop?.connectionOauthLogin) {
        const r = await desktop.connectionOauthLogin(url);
        if (r.ok) {
          notifyConnectionAuthRestored();
          return;
        }
      }
    } catch {
      // Keep the banner up so the user can retry.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "fixed", bottom: 16, left: 16, right: 16, zIndex: 50, maxWidth: 520, margin: "0 auto" }}>
      <Alert tone="error" size="sm">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AlertTriangle size={16} />
            远程登录已过期，需要重新登录才能继续连接。
          </span>
          <Button type="button" variant="solid" tone="accent" onClick={() => void handleRelogin()} disabled={busy} aria-busy={busy}>
            {busy && <Loader2 size={13} />}
            重新登录
          </Button>
        </div>
      </Alert>
    </div>
  );
}
