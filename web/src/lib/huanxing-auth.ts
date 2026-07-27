// Huanxing-api（new-api 企业版 fork）认证 client。
// 主 /api/* 路由无 CORS，桌面 WebView 必须通过 Rust IPC 代理请求。

import { BRAND } from "./brand.generated";

export const DEFAULT_HUANXING_SERVER_URL = BRAND.serviceUrl;

export interface HuanxingUser {
  id: number;
  username: string;
  display_name?: string;
  role?: number;
  status?: number;
  group?: string;
  /** 0 = 普通用户，1 = 企业管理员，2 = 子账号 */
  type?: number;
  topid?: number;
  enterprise_id?: number;
  enterprise_name?: string;
}

export interface HuanxingAccount {
  serverUrl: string;
  userId: number;
  username: string;
  displayName?: string;
  type?: number;
  topid?: number;
  enterpriseId?: number;
  enterpriseName?: string;
  accessToken?: string;
  sessionCookie?: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}

export function normalizeHuanxingServerUrl(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_HUANXING_SERVER_URL;
}

export function huanxingAccountTypeLabel(type: number | undefined): string {
  if (type === 1) return "企业管理员";
  if (type === 2) return "子账号";
  return "标准账号";
}

export function huanxingAuthHeaders(account: HuanxingAccount): Record<string, string> {
  const headers: Record<string, string> = { "New-Api-User": String(account.userId) };
  if (account.accessToken) headers.Authorization = account.accessToken;
  else if (account.sessionCookie) headers.Cookie = account.sessionCookie;
  return headers;
}

function requireExternalRequest() {
  const bridge = typeof window !== "undefined" ? window.hermesDesktop : undefined;
  if (!bridge?.externalRequest) {
    throw new Error("当前运行环境不支持外部请求（需要桌面端 IPC 代理）");
  }
  return bridge.externalRequest.bind(bridge);
}

function extractSessionCookie(headers: Record<string, string>): string | undefined {
  const raw = headers["set-cookie"] ?? headers["Set-Cookie"];
  if (!raw) return undefined;
  const match = raw.match(/(?:^|,\s*)session=[^;,]+/i);
  return match ? match[0].replace(/^\s+/, "") : undefined;
}

async function callApi<T>(
  serverUrl: string,
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ data: T; headers: Record<string, string> }> {
  const externalRequest = requireExternalRequest();
  const headers: Record<string, string> = { ...(init?.headers ?? {}) };
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  const result = await externalRequest({
    path: `${normalizeHuanxingServerUrl(serverUrl)}${path}`,
    method: init?.method ?? "GET",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : null,
  });
  let envelope: ApiEnvelope<T> | null = null;
  try {
    envelope = result.body ? (JSON.parse(result.body) as ApiEnvelope<T>) : null;
  } catch {
    envelope = null;
  }
  if (!result.ok) throw new Error(envelope?.message || `请求失败（HTTP ${result.status}）`);
  if (!envelope || envelope.success !== true) throw new Error(envelope?.message || "请求失败");
  return { data: envelope.data as T, headers: result.headers };
}

export async function loginHuanxingAccount(
  serverUrl: string,
  username: string,
  password: string,
): Promise<HuanxingAccount> {
  const base = normalizeHuanxingServerUrl(serverUrl);
  const { data: user, headers } = await callApi<HuanxingUser & { require_2fa?: boolean }>(
    base,
    "/api/user/login",
    { method: "POST", body: { username: username.trim(), password } },
  );
  if (user?.require_2fa) {
    throw new Error("该账号开启了两步验证（2FA），桌面端暂不支持，请在后台关闭后重试。");
  }
  if (!user || typeof user.id !== "number") throw new Error("登录响应缺少用户信息。");
  const sessionCookie = extractSessionCookie(headers);
  const account: HuanxingAccount = {
    serverUrl: base,
    userId: user.id,
    username: user.username,
    displayName: user.display_name || undefined,
    type: user.type,
    topid: user.topid,
    enterpriseId: user.enterprise_id,
    enterpriseName: user.enterprise_name || undefined,
    sessionCookie,
  };
  if (sessionCookie) {
    try {
      const { data: token } = await callApi<string>(base, "/api/user/token", {
        headers: huanxingAuthHeaders(account),
      });
      if (typeof token === "string" && token) account.accessToken = token;
    } catch {
      // session cookie remains available as a fallback
    }
  }
  return account;
}

export async function registerHuanxingAccount(
  serverUrl: string,
  username: string,
  password: string,
  email?: string,
): Promise<void> {
  await callApi<unknown>(normalizeHuanxingServerUrl(serverUrl), "/api/user/register", {
    method: "POST",
    body: {
      username: username.trim(),
      password,
      ...(email?.trim() ? { email: email.trim() } : {}),
    },
  });
}

export async function fetchHuanxingSelf(account: HuanxingAccount): Promise<HuanxingAccount> {
  const { data: user } = await callApi<HuanxingUser>(account.serverUrl, "/api/user/self", {
    headers: huanxingAuthHeaders(account),
  });
  return {
    ...account,
    username: user?.username ?? account.username,
    displayName: user?.display_name || undefined,
    type: user?.type ?? account.type,
    topid: user?.topid ?? account.topid,
    enterpriseId: user?.enterprise_id ?? account.enterpriseId,
    enterpriseName: user?.enterprise_name || undefined,
  };
}
