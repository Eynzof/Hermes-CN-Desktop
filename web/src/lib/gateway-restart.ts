import type { HostOS } from "@/lib/runtime";

export const GATEWAY_RESTART_ACTION_NAME = "gateway-restart";

export type GatewayRestartPhase = "idle" | "starting" | "running" | "success" | "error";

// A gateway start/restart that fails on Windows is, in the field, most often a
// security-suite false positive (360 / 火绒 / Windows Defender) killing the
// unsigned frozen runtime. Surface that as actionable guidance next to the retry
// affordance instead of leaving the user with an opaque failure (issue #224).
export const GATEWAY_RESTART_ANTIVIRUS_HINT =
  "若反复失败，接收服务可能被安全软件（360 / 火绒 / Windows Defender 等）拦截。请将 Hermes 加入信任 / 白名单后重试。";

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
  if (phase === "starting" || phase === "running") return "正在重启接收服务";
  if (phase === "success") return "接收服务已重启";
  if (phase === "error") return "接收服务重启失败，点击重试";
  return "重启接收服务";
}

export function classifyGatewayActionStatus(
  status: GatewayActionStatusResponse,
): GatewayActionStatusClassification {
  if (status.running) {
    return {
      done: false,
      ok: false,
      message: "接收服务重启中…",
    };
  }

  if (status.exit_code === 0 || status.exit_code === null) {
    return {
      done: true,
      ok: true,
      message: "接收服务已重启",
    };
  }

  return {
    done: true,
    ok: false,
    message: "接收服务重启失败",
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
  return response.message || response.error || "接收服务重启请求失败";
}
