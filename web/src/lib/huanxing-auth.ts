// Huanxing-api（new-api 企业版 fork）认证 client。
//
// 关键契约（来自后端调研）：
// - 统一响应信封 {"success": bool, "message": string, "data": ...}；
//   业务错误多为 HTTP 200 + success:false，认证中间件拦截才返回非 200。
// - 登录 POST /api/user/login 返回用户对象（type: 0 普通 / 1 企业管理员 / 2 子账号，
//   topid = 父账号 ID），凭证是 session cookie（HttpOnly, 30 天）。
// - GET /api/user/token 用登录 cookie 换长效 access_token；之后的请求两种带法：
//   Authorization: <access_token> 或 Cookie: session=...，**都必须同时带
//   header `New-Api-User: <用户id>`**（两种模式下中间件都会校验）。
// - 注册 POST /api/user/register 不自动登录，成功后再走登录。
// - 主 /api/* 路由组无 CORS 中间件，webview 直连会被拦——必须走 Rust IPC
//   代理（window.hermesDesktop.externalRequest）。

import { BRAND } from "./brand.generated";

export const DEFAULT_HUANXING_SERVER_URL = BRAND.serviceUrl;

export interface HuanxingUser {
  id: number;
  username: string;
  display_name?: string;
  role?: number;
  status?: number;
  group?: string;
  /** 0 = 普通用户，1 = 企业管理员（父账号），2 = 子账号 */
  type?: number;
  /** 子账号的父账号 ID */
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
  /** 长效 access_token（优先使用） */
  accessToken?: string;
  /** 兜底：登录会话 cookie（拿不到 access_token 时使用） */
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

/** 后续请求需要的认证头（两种模式都要带 New-Api-User）。 */
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
  if (!result.ok) {
    throw new Error(envelope?.message || `请求失败（HTTP ${result.status}）`);
  }
  if (!envelope || envelope.success !== true) {
    throw new Error(envelope?.message || "请求失败");
  }
  return { data: envelope.data as T, headers: result.headers };
}

/**
 * 登录：POST /api/user/login → 用户信息 + session cookie；
 * 随后尽力用 cookie 换长效 access_token（失败则保留 cookie 模式）。
 */
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
  if (!user || typeof user.id !== "number") {
    throw new Error("登录响应缺少用户信息。");
  }
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
  // 换长效 access_token（尽力而为；失败不阻塞登录，后续走 cookie 模式）。
  if (sessionCookie) {
    try {
      const { data: token } = await callApi<string>(base, "/api/user/token", {
        headers: huanxingAuthHeaders(account),
      });
      if (typeof token === "string" && token) account.accessToken = token;
    } catch {
      // 保留 cookie 兜底
    }
  }
  return account;
}

/** 注册：POST /api/user/register。成功不自动登录，调用方再引导登录。 */
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

/** 校验/刷新账号信息（GET /api/user/self）。token 失效会抛错。 */
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
