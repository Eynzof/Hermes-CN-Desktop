import type { StatusResponse } from "@hermes/protocol";

type HealthSubtitleStatus = Pick<StatusResponse, "gateway_running" | "gateway_state" | "version">;

function versionLabel(version: string | undefined): string {
  const clean = version?.trim();
  return clean ? `v${clean}` : "版本未知";
}

function gatewayStateLabel(status: HealthSubtitleStatus): string {
  const rawState = status.gateway_state?.trim() ?? "";
  const state = rawState.toLowerCase();

  if (status.gateway_running || state === "running") return "网关运行中";
  if (state === "starting" || state === "initializing") return "网关启动中";
  if (state === "error" || state === "failed" || state === "crashed") return "网关异常";

  // P-009 后聊天传输走 in-process dispatch，daemon 不运行也可以是健康状态。
  // 因此后端返回空值、unknown 或 stopped 时，页头应表达内核已可用，
  // 不要把 raw gateway_state 暴露给用户造成误解。
  if (!state || state === "unknown" || state === "stopped" || state === "null") {
    return "内核就绪";
  }

  return `网关 ${rawState}`;
}

export function formatHealthSubtitle(
  status: HealthSubtitleStatus | undefined,
  isError: boolean,
): string {
  if (isError) return "内核离线";
  if (!status) return "加载中…";
  return `${gatewayStateLabel(status)} · ${versionLabel(status.version)}`;
}
