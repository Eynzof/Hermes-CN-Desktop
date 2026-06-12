// 桌面通知触发链路（issue #194）。
//
// 在 applyGatewayEventAtom 消费 Gateway 事件时旁路调用（见 stores/chat.ts），
// 把「任务完成 / 需要权限确认」翻译成 desktop_notify IPC：Rust 侧负责前台
// 判定、系统通知（自带原生提示音）和 dock 弹跳 / 任务栏闪烁；本模块负责
// 决策（设置开关、防重放去重、文案）和系统通知不可用时的 WebAudio 兜底音。
//
// decideNotification / shouldPlayFallbackSound 是纯函数，便于 vitest 全矩阵
// 覆盖；所有副作用都 fire-and-forget 且错误吞掉，绝不影响聊天主流程。

import type { GatewayEvent, SessionsResponse } from "@hermes/protocol";
import type { ChatSessionRuntime } from "@/stores/chat";
import { readNotificationSettings, type NotificationSettings } from "@/stores/ui";
import type { DesktopNotifyResult } from "@/lib/runtime";
import { resolvePersistentSessionId } from "@/lib/session-map";
import { queryClient } from "@/lib/query-client";

export interface NotificationAction {
  dedupeKey: string;
  kind: "approval" | "complete" | "error";
  title: string;
  body: string;
}

const MAX_BODY_CHARS = 120;
const SUMMARY_CHARS = 80;
const SESSION_TITLE_CHARS = 24;
const MAX_DEDUPE_KEYS = 500;

function truncate(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

function payloadOf(event: GatewayEvent): Record<string, any> {
  return event.payload && typeof event.payload === "object"
    ? (event.payload as Record<string, any>)
    : {};
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function lastUserPromptSummary(
  runtime: ChatSessionRuntime | undefined,
  max: number,
): string | undefined {
  if (!runtime) return undefined;
  for (let i = runtime.messages.length - 1; i >= 0; i -= 1) {
    const message = runtime.messages[i];
    if (message.role !== "user") continue;
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ")
      .trim();
    if (text) return truncate(text, max);
  }
  return undefined;
}

export function decideNotification(input: {
  event: GatewayEvent;
  prevRuntime: ChatSessionRuntime | undefined;
  settings: NotificationSettings;
  alreadyNotified: (key: string) => boolean;
}): NotificationAction | null {
  const { event, prevRuntime, settings, alreadyNotified } = input;
  // 总闸：系统通知和提示音都关 = 用户不要任何打扰（注意力请求也不发）。
  if (!settings.system && !settings.sound) return null;
  const sessionId = event.session_id;
  if (!sessionId) return null;
  const payload = payloadOf(event);

  if (event.type === "approval.request") {
    if (!settings.onApproval) return null;
    const rawId = payload.request_id;
    const requestId =
      typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : "";
    // 没有可靠 request_id 就无法去重，宁可不通知也不在重放时轰炸。
    if (!requestId) return null;
    if (prevRuntime?.pendingApprovals.some((item) => item.requestId === requestId)) {
      return null;
    }
    const dedupeKey = `approval:${sessionId}:${requestId}`;
    if (alreadyNotified(dedupeKey)) return null;
    const detail = firstNonEmptyString([payload.command, payload.reason, payload.description]);
    return {
      dedupeKey,
      kind: "approval",
      title: "需要权限确认",
      body: truncate(detail ?? "任务等待你的确认后才能继续", MAX_BODY_CHARS),
    };
  }

  if (event.type === "message.complete") {
    if (!settings.onComplete) return null;
    // 重放防护：本地没有活跃回合（SSE 重连重放、历史 resume）或用户已手动
    // 中断时不通知。reducer 收尾后会清空 activeAssistantId，因此同一回合
    // 只有一次「在场」的 complete。
    const activeId = prevRuntime?.activeAssistantId;
    if (!activeId || prevRuntime?.interrupted) return null;
    const dedupeKey = `complete:${sessionId}:${activeId}`;
    if (alreadyNotified(dedupeKey)) return null;
    if (payload.status === "error") {
      const detail = firstNonEmptyString([
        payload.error,
        payload.message,
        payload.warning,
        payload.detail,
      ]);
      return {
        dedupeKey,
        kind: "error",
        title: "任务出错",
        body: truncate(detail ?? "任务执行失败，请回来查看详情", MAX_BODY_CHARS),
      };
    }
    return {
      dedupeKey,
      kind: "complete",
      title: "任务完成",
      body: lastUserPromptSummary(prevRuntime, SUMMARY_CHARS) ?? "会话回复已就绪",
    };
  }

  return null;
}

// ── 去重存储（module 级，FIFO 上限防泄漏）─────────────────────────────

const notifiedKeys = new Set<string>();
const notifiedOrder: string[] = [];

export function hasNotified(key: string): boolean {
  return notifiedKeys.has(key);
}

export function markNotified(key: string): void {
  if (notifiedKeys.has(key)) return;
  notifiedKeys.add(key);
  notifiedOrder.push(key);
  while (notifiedOrder.length > MAX_DEDUPE_KEYS) {
    const oldest = notifiedOrder.shift();
    if (oldest !== undefined) notifiedKeys.delete(oldest);
  }
}

export function __resetNotificationsForTests(): void {
  notifiedKeys.clear();
  notifiedOrder.length = 0;
}

// ── 会话标题（通知正文前缀）────────────────────────────────────────────

function sessionTitleFor(sessionId: string): string | undefined {
  try {
    const persistentId = resolvePersistentSessionId(sessionId) ?? sessionId;
    for (const [, data] of queryClient.getQueriesData<SessionsResponse>({
      queryKey: ["sessions"],
    })) {
      const match = data?.sessions.find((item) => item.id === persistentId);
      if (match?.title) return match.title;
    }
  } catch {
    // 标题只是锦上添花，任何失败都退回裸正文。
  }
  return undefined;
}

function bodyWithSessionTitle(body: string, sessionId: string): string {
  const title = sessionTitleFor(sessionId);
  if (!title) return body;
  return `「${truncate(title, SESSION_TITLE_CHARS)}」${body ? ` · ${body}` : ""}`;
}

// ── 提示音兜底 ──────────────────────────────────────────────────────────

export function shouldPlayFallbackSound(
  settings: NotificationSettings,
  result: Pick<DesktopNotifyResult, "delivered" | "focused" | "error">,
): boolean {
  if (!settings.sound) return false;
  // 窗口在前台且用户只要后台提醒：Rust 侧已整体抑制，这里也保持安静。
  if (result.focused && settings.onlyBackground) return false;
  // 系统通知正常发出时提示音由通知自身携带，不再补播。
  if (settings.system && result.delivered && !result.error) return false;
  return true;
}

let chimeAudioContext: AudioContext | undefined;

function chimeContext(): AudioContext | undefined {
  if (typeof AudioContext === "undefined") return undefined;
  try {
    if (!chimeAudioContext) chimeAudioContext = new AudioContext();
    if (chimeAudioContext.state === "suspended") {
      void chimeAudioContext.resume().catch(() => {});
    }
    return chimeAudioContext;
  } catch {
    return undefined;
  }
}

/** WebAudio 合成的两音上行 chime（A5 → E6，约 0.45s），零音频资产。 */
export function playChime(): void {
  const ctx = chimeContext();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.4, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    gain.connect(ctx.destination);
    const notes: ReadonlyArray<readonly [number, number]> = [
      [880, now],
      [1318.5, now + 0.12],
    ];
    for (const [frequency, at] of notes) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, at);
      osc.connect(gain);
      osc.start(at);
      osc.stop(now + 0.5);
    }
  } catch {
    // 播放失败保持静默。
  }
}

// ── 触发器（副作用入口，错误全吞）──────────────────────────────────────

export function notifyFromGatewayEvent(
  event: GatewayEvent,
  prevRuntime: ChatSessionRuntime | undefined,
): void {
  try {
    const bridge = window.hermesDesktop;
    if (typeof bridge?.desktopNotify !== "function") return;
    const settings = readNotificationSettings();
    const action = decideNotification({
      event,
      prevRuntime,
      settings,
      alreadyNotified: hasNotified,
    });
    if (!action || !event.session_id) return;
    markNotified(action.dedupeKey);
    void bridge
      .desktopNotify({
        kind: action.kind,
        title: action.title,
        body: bodyWithSessionTitle(action.body, event.session_id),
        showSystemNotification: settings.system,
        withSound: settings.sound,
        respectFocus: settings.onlyBackground,
        requestAttention: true,
      })
      .then((result) => {
        if (result && shouldPlayFallbackSound(settings, result)) playChime();
      })
      .catch(() => {});
  } catch {
    // 通知永远不能影响聊天主流程。
  }
}
