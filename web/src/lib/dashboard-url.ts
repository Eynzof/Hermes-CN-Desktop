const DEFAULT_DESKTOP_DASHBOARD_PORT = "9120";

interface DashboardRuntimeConfig {
  apiBaseUrl?: string;
  dashboardApiBaseUrl?: string;
}

interface DashboardUrlInputs {
  healthUrl?: string | null;
  runtimeConfig?: DashboardRuntimeConfig | null;
  envOrigin?: string | null;
}

function parseHttpUrl(raw: string | null | undefined): URL | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

function loopbackDisplayHost(hostname: string): string {
  return ["127.0.0.1", "::1", "[::1]", "localhost"].includes(hostname)
    ? "localhost"
    : hostname;
}

function originFromUrl(url: URL): string {
  const host = loopbackDisplayHost(url.hostname);
  const port = url.port ? `:${url.port}` : "";
  return `${url.protocol}//${host}${port}/`;
}

export function dashboardUrlFromInputs(inputs: DashboardUrlInputs): string {
  const candidates = [
    inputs.healthUrl,
    inputs.runtimeConfig?.dashboardApiBaseUrl,
    inputs.runtimeConfig?.apiBaseUrl,
    inputs.envOrigin,
  ];

  for (const candidate of candidates) {
    const url = parseHttpUrl(candidate);
    if (url) return originFromUrl(url);
  }

  return `http://localhost:${DEFAULT_DESKTOP_DASHBOARD_PORT}/`;
}

export function dashboardPortFromUrl(raw: string | null | undefined): string {
  const url = parseHttpUrl(raw);
  if (!url) return DEFAULT_DESKTOP_DASHBOARD_PORT;
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}
