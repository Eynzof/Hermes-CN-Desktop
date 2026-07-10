// 匿名使用统计。上报到 landing 站点的 Cloudflare Worker
// （POST /api/telemetry → Workers Analytics Engine），只含版本 / 系统类型 /
// 语言这类聚合字段与一个本地随机生成的 device_id，不含对话内容、密钥或
// 任何硬件指纹。默认开启，可在「设置 → 常规」关闭（hermes.telemetry-enabled）。
import { fetchExternalJSON } from "./transport";
import { readUiValue, writeUiValue } from "./ui-store";
import { detectHostOS } from "./runtime";
import { DESKTOP_VERSION } from "./build-info";
import { BUILTIN_PROVIDER_CATALOG_VERSION } from "./provider-catalog";

const DEFAULT_TELEMETRY_URL = "https://desktop.hermesagent.org.cn/api/telemetry";

export const TELEMETRY_ENABLED_KEY = "hermes.telemetry-enabled";
const DEVICE_ID_KEY = "hermes.telemetry-device-id";
const LAST_PING_KEY = "hermes.telemetry-last-ping-at";

export const PING_INTERVAL_MS = 24 * 60 * 60 * 1000;

function telemetryUrl(): string {
  const override = import.meta.env.VITE_HERMES_TELEMETRY_URL;
  return typeof override === "string" && override.trim()
    ? override.trim()
    : DEFAULT_TELEMETRY_URL;
}

export function isTelemetryEnabled(): boolean {
  return readUiValue<unknown>(TELEMETRY_ENABLED_KEY, true) !== false;
}

function telemetryDeviceId(): string {
  const existing = readUiValue<unknown>(DEVICE_ID_KEY, "");
  if (typeof existing === "string" && existing.trim()) return existing;
  const generated = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  writeUiValue(DEVICE_ID_KEY, generated);
  return generated;
}

/** 纯函数：距上次 ping 是否已超过间隔（时间戳非法视为“该发”）。 */
export function isPingDue(lastPingAt: unknown, now: number, interval = PING_INTERVAL_MS): boolean {
  const last = typeof lastPingAt === "number" ? lastPingAt : Number(lastPingAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  return now - last >= interval;
}

export interface TelemetryPayload {
  event: "ping" | "promo_click";
  device_id: string;
  app_version: string;
  os: string;
  locale: string;
  catalog_version: string;
  provider_id?: string;
}

export function buildTelemetryPayload(
  event: TelemetryPayload["event"],
  deviceId: string,
  providerId?: string,
): TelemetryPayload {
  return {
    event,
    device_id: deviceId,
    app_version: DESKTOP_VERSION,
    os: detectHostOS(),
    locale: typeof navigator !== "undefined" ? navigator.language : "unknown",
    catalog_version: BUILTIN_PROVIDER_CATALOG_VERSION,
    ...(providerId ? { provider_id: providerId } : {}),
  };
}

async function post(payload: TelemetryPayload): Promise<void> {
  await fetchExternalJSON<unknown>(telemetryUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** 启动 / 每 24h 一次的匿名 ping。失败静默，绝不影响主流程。 */
export async function sendTelemetryPingIfDue(now = Date.now()): Promise<boolean> {
  if (!isTelemetryEnabled()) return false;
  if (!isPingDue(readUiValue<unknown>(LAST_PING_KEY, 0), now)) return false;
  // 先落时间戳再发送：失败也等下个周期重试，避免异常时高频打点。
  writeUiValue(LAST_PING_KEY, now);
  try {
    await post(buildTelemetryPayload("ping", telemetryDeviceId()));
    return true;
  } catch {
    return false;
  }
}

/** 「前往官网」点击事件（fire-and-forget），用于评估各供应商推广位转化。 */
export function reportPromoClick(providerId: string): void {
  if (!isTelemetryEnabled() || !providerId) return;
  void post(buildTelemetryPayload("promo_click", telemetryDeviceId(), providerId)).catch(() => {});
}
