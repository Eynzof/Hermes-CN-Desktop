import type { SoftwareUpdateComponent, SoftwareUpdateState } from "@hermes/protocol";
import { DESKTOP_VERSION } from "./build-info";
import { flushUiStore, readUiValue, writeUiValue } from "./ui-store";
import { runtime } from "./runtime";
import { forceExistingGatewayReconnect } from "./gateway-client";
import { queryClient } from "./query-client";

export const UPDATE_REMINDER_KEY = "software-update.remind-after";
export const UPDATE_ROUTE_KEY = "software-update.return-route";
export const UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const UPDATE_REMIND_MS = 24 * 60 * 60 * 1000;

export const INITIAL_UPDATE_STATE: SoftwareUpdateState = {
  phase: "idle", currentVersion: DESKTOP_VERSION, channel: "stable", customSource: false,
  development: false, checkedAt: null, targets: [], progress: null, downloadedBytes: 0,
  totalBytes: null, currentComponent: null, error: null, warnings: [], activities: [],
  activityError: null, downloadSource: null, reloadRequired: false, completedAt: null,
};
let snapshot = INITIAL_UPDATE_STATE;
const subscribers = new Set<() => void>();
export const getSoftwareUpdateState = () => snapshot;
export function subscribeSoftwareUpdate(listener: () => void) {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}
export function acceptSoftwareUpdateState(state: SoftwareUpdateState) {
  snapshot = state;
  subscribers.forEach((listener) => listener());
}

async function invoke(operation: (() => Promise<SoftwareUpdateState>) | undefined) {
  try {
    if (!operation) throw new Error("请重新启动新版桌面应用后使用软件更新。");
    const result = await operation();
    acceptSoftwareUpdateState(result);
    return result;
  } catch (error) {
    acceptSoftwareUpdateState({ ...snapshot, error: { code: "bridge_error", message: "操作未完成，请稍后重试。", detail: String(error) } });
    return snapshot;
  }
}

export const refreshSoftwareUpdate = () => invoke(window.hermesDesktop?.softwareUpdateSnapshot);
export const checkSoftwareUpdate = (component: SoftwareUpdateComponent = "all") =>
  invoke(window.hermesDesktop?.softwareUpdateCheck ? () => window.hermesDesktop!.softwareUpdateCheck!(component) : undefined);
export const downloadSoftwareUpdate = () => invoke(window.hermesDesktop?.softwareUpdateDownload);
export const cancelSoftwareUpdate = () => invoke(window.hermesDesktop?.softwareUpdateCancel);

async function saveUpdateContext() {
  window.dispatchEvent(new Event("hermes-before-update"));
  writeUiValue(UPDATE_ROUTE_KEY, window.location.hash);
  try { await flushUiStore(); } catch (error) {
    acceptSoftwareUpdateState({ ...snapshot, error: { code: "draft_save_failed", message: "草稿尚未保存，请稍后重试更新。", detail: String(error) } });
    return false;
  }
  return true;
}

export async function applySoftwareUpdate() {
  if (!await saveUpdateContext()) return snapshot;
  const result = await invoke(window.hermesDesktop?.softwareUpdateApply);
  if (result.reloadRequired) {
    // IPC has resolved. Reloading earlier causes WebView to replay the mutation.
    window.location.reload();
  } else if (result.phase === "completed" || result.phase === "error") {
    await runtime.refreshGatewayUrl().catch(() => undefined);
    forceExistingGatewayReconnect("software-update");
    window.dispatchEvent(new Event("hermes-runtime-changed"));
    await queryClient.invalidateQueries({ queryKey: ["desktop-runtime-info"] });
  }
  return result;
}

export async function rollbackSoftwareUpdate(component: "runtime" | "ui") {
  if (!await saveUpdateContext()) return snapshot;
  const result = await invoke(window.hermesDesktop?.softwareUpdateRollback ? () => window.hermesDesktop!.softwareUpdateRollback!(component) : undefined);
  if (result.reloadRequired) window.location.reload();
  else {
    await runtime.refreshGatewayUrl().catch(() => undefined);
    forceExistingGatewayReconnect("software-update-rollback");
    await queryClient.invalidateQueries({ queryKey: ["desktop-runtime-info"] });
  }
  return result;
}

export function updateIdentity(state: SoftwareUpdateState): string {
  return `${state.channel}:${state.targets.map((target) => `${target.kind}:${target.version}`).join("|")}`;
}

export function shouldRemindUpdate(state: SoftwareUpdateState, remembered: Record<string, number>, now = Date.now()) {
  return ["available", "ready"].includes(state.phase) && state.targets.length > 0
    && state.activities.length === 0 && !state.activityError
    && (remembered[`${updateIdentity(state)}:${state.phase === "ready" ? "ready" : "available"}`] ?? 0) <= now;
}

export function postponeUpdate(state: SoftwareUpdateState, now = Date.now()) {
  const remembered = readUiValue<Record<string, number>>(UPDATE_REMINDER_KEY, {});
  // Keep only unexpired reminders; a new version has its own identity.
  const next = Object.fromEntries(Object.entries(remembered).filter(([, until]) => until > now));
  next[`${updateIdentity(state)}:${state.phase === "ready" ? "ready" : "available"}`] = now + UPDATE_REMIND_MS;
  writeUiValue(UPDATE_REMINDER_KEY, next);
}

export function updateStatusLabel(state: SoftwareUpdateState): string {
  switch (state.phase) {
    case "checking": return "正在检查更新";
    case "available": return "有可用更新";
    case "downloading": return state.progress == null ? "更新下载中" : `更新下载中 ${Math.floor(state.progress)}%`;
    case "ready": return "更新已就绪";
    case "waiting": return "任务结束后可更新";
    case "applying": return "正在应用更新";
    case "error": return "更新未完成";
    default: return `v${state.currentVersion}`;
  }
}

export function updateImpact(state: SoftwareUpdateState): string {
  if (state.targets.some((target) => target.kind === "app")) return "下载期间可以继续使用，安装时需要重启应用。";
  if (state.targets.some((target) => target.kind === "runtime")) return "应用更新时会短暂重启内核，对话和设置将保留。";
  return "应用更新时会刷新界面，内核无需重启。";
}

export function applyUpdateLabel(state: SoftwareUpdateState): string {
  if (state.targets.some((target) => target.kind === "app")) return "重启应用并安装";
  if (state.targets.some((target) => target.kind === "runtime")) return "重启内核并应用";
  return "刷新界面并应用";
}
