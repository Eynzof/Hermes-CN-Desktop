import type { HostOS } from "@/lib/runtime";

export const GATEWAY_RESTART_ACTION_NAME = "gateway-restart";

export type GatewayRestartPhase = "idle" | "starting" | "running" | "success" | "error";

// A gateway start/restart that fails on Windows is, in the field, most often a
// security-suite false positive (360 / 火绒 / Windows Defender) killing the
// unsigned frozen runtime. Surface that as actionable guidance next to the retry
// affordance instead of leaving the user with an opaque failure (issue #224).
export const GATEWAY_RESTART_ANTIVIRUS_HINT =
  "若反复失败，网关可能被安全软件（360 / 火绒 / Windows Defender 等）拦截。请将 Hermes 加入信任 / 白名单后重试。";

/** The antivirus hint, shown only on Windows where it applies; empty elsewhere. */
export function gatewayRestartAntivirusHint(hostOs: HostOS): string {
  return hostOs === "windows" ? GATEWAY_RESTART_ANTIVIRUS_HINT : "";
}

export interface GatewayRestartResponse {
  ok: boolean;
  pid?: number | null;
  name?: string | null;
  error?: string | null;
  message?: string | null;
}

export interface GatewayActionStatusResponse {
  name: string;
  running: boolean;
  exit_code: number | null;
  pid: number | null;
  lines: string[];
}

export interface GatewayActionStatusClassification {
  done: boolean;
  ok: boolean;
  message: string;
}

export interface GatewayRuntimeStatus {
  gateway_running?: boolean;
  gateway_pid?: number | null;
  gateway_state?: string | null;
}

export function isGatewayRestartBusy(phase: GatewayRestartPhase): boolean {
  return phase === "starting" || phase === "running";
}

export function isGatewayRestartLocked(phase: GatewayRestartPhase): boolean {
  return phase === "starting" || phase === "running" || phase === "success";
}

export function gatewayRestartButtonLabel(phase: GatewayRestartPhase): string {
  if (phase === "starting" || phase === "running") return "重启中…";
  if (phase === "success") return "已完成";
  if (phase === "error") return "重试";
  return "重启";
}

export function gatewayRestartTitle(
  phase: GatewayRestartPhase,
  message?: string | null,
): string {
  if (message) return message;
  if (phase === "starting" || phase === "running") return "正在重启 Gateway";
  if (phase === "success") return "Gateway 重启已完成";
  if (phase === "error") return "Gateway 重启失败，点击重试";
  return "重启 Gateway";
}

export function classifyGatewayActionStatus(
  status: GatewayActionStatusResponse,
): GatewayActionStatusClassification {
  if (status.running) {
    return {
      done: false,
      ok: false,
      message: status.pid ? `Gateway 重启中（PID ${status.pid}）…` : "Gateway 重启中…",
    };
  }

  if (status.exit_code === 0 || status.exit_code === null) {
    return {
      done: true,
      ok: true,
      message: "Gateway 重启已完成",
    };
  }

  return {
    done: true,
    ok: false,
    message: `Gateway 重启失败（exit ${status.exit_code}）`,
  };
}

export function isGatewayRestartObservedRunning(
  actionStatus: GatewayActionStatusResponse,
  runtimeStatus: GatewayRuntimeStatus,
): boolean {
  if (!runtimeStatus.gateway_running) return false;
  if (
    actionStatus.pid &&
    runtimeStatus.gateway_pid &&
    actionStatus.pid !== runtimeStatus.gateway_pid
  ) {
    return false;
  }

  const state = (runtimeStatus.gateway_state ?? "").trim().toLowerCase();
  return state === "" || state === "running" || state === "ready";
}

export function gatewayRestartResponseError(response: GatewayRestartResponse): string | null {
  if (response.ok) return null;
  return response.message || response.error || "Gateway 重启请求失败";
}
