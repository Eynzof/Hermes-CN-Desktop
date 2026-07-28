interface BrowserCompanionLaunch {
  origin: string;
  token: string;
}

interface BrowserCompanionLocation {
  hash: string;
  pathname: string;
  search: string;
}

function isLoopbackHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

export function parseBrowserCompanionLaunch(
  location: BrowserCompanionLocation,
): BrowserCompanionLaunch | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const origin = params.get("hermes-browser-origin")?.replace(/\/$/, "") ?? "";
  const token = params.get("hermes-browser-token") ?? "";
  if (!origin || !token || !isLoopbackHttpOrigin(origin)) return null;
  return { origin, token };
}

export async function installBrowserCompanionRuntime(
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const launch = parseBrowserCompanionLaunch(window.location);
  if (!launch) return false;

  const response = await fetchImpl(`${launch.origin}/__hermes_runtime`, {
    headers: {
      Authorization: `Bearer ${launch.token}`,
      "X-Hermes-Browser-Token": launch.token,
    },
  });
  if (!response.ok) {
    throw new Error(`浏览器伴生服务连接失败（HTTP ${response.status}）`);
  }

  const config = await response.json() as NonNullable<Window["__HERMES_RUNTIME__"]>;
  if (!config.browserCompanion || !config.sessionToken || !config.apiBaseUrl || !config.gatewayUrl) {
    throw new Error("浏览器伴生服务返回了无效的运行时配置");
  }
  window.__HERMES_RUNTIME__ = config;
  window.__HERMES_SESSION_TOKEN__ = config.sessionToken;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return true;
}
