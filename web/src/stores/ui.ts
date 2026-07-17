import { atom } from "jotai";
import type { ComposerSubmitShortcut } from "@/lib/composer-submit-shortcut";
import { readUiValue, writeUiValue } from "@/lib/ui-store";
import hermesDefaultAvatar from "@/assets/hermes-default-avatar.png";

export const activeSessionIdAtom = atom<string | null>(null);

// Maps a pre-compression persistent session id to the live continuation "tip"
// that the backend redirected a `session.resume` to. The detail route watches
// this so the URL/active id follows the backend's new tip after compression
// instead of stranding the user on a session whose messages have moved — the
// "conversation vanished + #2/#3 duplicate" symptom (issue #305). Populated by
// resumeSession via recordTipRedirect; consumed by the detail route effect.
export const sessionTipRedirectAtom = atom<Record<string, string>>({});

export const sidebarSearchAtom = atom("");
export const commandPaletteOpenAtom = atom(false);

export const CONVERSATION_WIDTH_OPTIONS = [
  // 档位整体上调一档（用户反馈原「小/中」过窄）：大 = 960 + 头像列
  // 46px（36px 头像 + 10px gap），正文有效宽度与原「大」一致。
  { value: "small", label: "小", title: "小宽度", maxWidth: "780px" },
  { value: "medium", label: "中", title: "中等宽度", maxWidth: "960px" },
  { value: "large", label: "大", title: "大宽度", maxWidth: "1006px" },
  { value: "full", label: "满", title: "铺满宽度", maxWidth: "100%" },
] as const;

export type ConversationWidthMode = typeof CONVERSATION_WIDTH_OPTIONS[number]["value"];

export const CONVERSATION_FONT_SIZE_OPTIONS = [
  { value: "small", label: "小", title: "小字号", fontSize: "13px", lineHeight: "1.72" },
  { value: "standard", label: "标准", title: "标准字号", fontSize: "14px", lineHeight: "1.78" },
  { value: "large", label: "大", title: "大字号", fontSize: "15.5px", lineHeight: "1.82" },
] as const;

export type ConversationFontSizeMode = typeof CONVERSATION_FONT_SIZE_OPTIONS[number]["value"];

export const DEFAULT_ASSISTANT_DISPLAY_NAME = "Hermes";
export const ASSISTANT_DISPLAY_NAME_KEY = "hermes.assistant-display-name";
export const ASSISTANT_AVATAR_KEY = "hermes.assistant-avatar-data-url";
const MAX_ASSISTANT_DISPLAY_NAME_LENGTH = 40;

const DEFAULT_CONVERSATION_WIDTH_MODE: ConversationWidthMode = "large";
const CONVERSATION_WIDTH_KEY = "hermes.conversation-width";
const CONVERSATION_WIDTH_VALUES = CONVERSATION_WIDTH_OPTIONS.map((option) => option.value);
const DEFAULT_CONVERSATION_FONT_SIZE_MODE: ConversationFontSizeMode = "standard";
const CONVERSATION_FONT_SIZE_KEY = "hermes.conversation-font-size";
const CONVERSATION_FONT_SIZE_VALUES = CONVERSATION_FONT_SIZE_OPTIONS.map((option) => option.value);

export function normalizeConversationWidthMode(value: unknown): ConversationWidthMode {
  return CONVERSATION_WIDTH_VALUES.includes(value as ConversationWidthMode)
    ? (value as ConversationWidthMode)
    : DEFAULT_CONVERSATION_WIDTH_MODE;
}

export function conversationWidthMaxWidth(mode: ConversationWidthMode): string {
  return CONVERSATION_WIDTH_OPTIONS.find((option) => option.value === mode)?.maxWidth ?? "780px";
}

export function normalizeConversationFontSizeMode(value: unknown): ConversationFontSizeMode {
  return CONVERSATION_FONT_SIZE_VALUES.includes(value as ConversationFontSizeMode)
    ? (value as ConversationFontSizeMode)
    : DEFAULT_CONVERSATION_FONT_SIZE_MODE;
}

export function conversationFontSizeVars(mode: ConversationFontSizeMode): { fontSize: string; lineHeight: string } {
  const option = CONVERSATION_FONT_SIZE_OPTIONS.find((item) => item.value === mode)
    ?? CONVERSATION_FONT_SIZE_OPTIONS[1];
  return { fontSize: option.fontSize, lineHeight: option.lineHeight };
}

export function normalizeAssistantDisplayName(value: unknown): string {
  const trimmed = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!trimmed) return DEFAULT_ASSISTANT_DISPLAY_NAME;
  return Array.from(trimmed).slice(0, MAX_ASSISTANT_DISPLAY_NAME_LENGTH).join("");
}

export function normalizeAssistantAvatarDataUrl(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i.test(text) ? text : "";
}

const conversationWidthModeBaseAtom = atom<ConversationWidthMode>(
  normalizeConversationWidthMode(readUiValue(CONVERSATION_WIDTH_KEY, DEFAULT_CONVERSATION_WIDTH_MODE)),
);
export const conversationWidthModeAtom = atom(
  (get) => get(conversationWidthModeBaseAtom),
  (_get, set, next: ConversationWidthMode) => {
    const value = normalizeConversationWidthMode(next);
    set(conversationWidthModeBaseAtom, value);
    writeUiValue(CONVERSATION_WIDTH_KEY, value);
  },
);

const conversationFontSizeBaseAtom = atom<ConversationFontSizeMode>(
  normalizeConversationFontSizeMode(readUiValue(CONVERSATION_FONT_SIZE_KEY, DEFAULT_CONVERSATION_FONT_SIZE_MODE)),
);
export const conversationFontSizeAtom = atom(
  (get) => get(conversationFontSizeBaseAtom),
  (_get, set, next: ConversationFontSizeMode) => {
    const value = normalizeConversationFontSizeMode(next);
    set(conversationFontSizeBaseAtom, value);
    writeUiValue(CONVERSATION_FONT_SIZE_KEY, value);
  },
);

// Active profile name. Persisted in the UI SQLite store so refresh keeps
// the user's choice. "default" is the upstream's reserved name for the root
// HERMES_HOME (~/.hermes), so we use it both as the literal default profile
// label and as the bootstrap value before the backend has been queried.
//
// Web 模式（v2 dev / 公网部署）下 dashboard 仍绑启动时的 HERMES_HOME，切换
// profile 只更新 sticky 默认值——生效需要用户重启 dashboard（direction A）。
// Desktop 模式 (Electron) 下主进程 own dashboard 子进程，切换走 IPC →
// stop + spawn，真正即时生效（direction B）。X-Hermes-Profile header 是给
// 未来 fork 改造支持 per-request 路由用的占位（direction C）。
const activeProfileBaseAtom = atom<string>(readUiValue("hermes.active-profile", "default"));
export const activeProfileAtom = atom(
  (get) => get(activeProfileBaseAtom),
  (_get, set, next: string) => {
    set(activeProfileBaseAtom, next);
    writeUiValue("hermes.active-profile", next);
  },
);

// 「管理范围」：UI 当前正在查看/编辑*哪个*档案的 settings（如技能），不切换、不重启
// 运行中的 dashboard——区别于上面会重启 dashboard 的「活跃档案」。会话级、不持久化
// （默认 null = 跟随活跃档案），由 /skills?profile= 深链或档案页「管理技能」动作设置，
// 切换活跃档案时清空。对齐官方 dashboard 的 management-profile scope。
export const managementProfileAtom = atom<string | null>(null);

const assistantDisplayNameBaseAtom = atom<string>(
  normalizeAssistantDisplayName(readUiValue(ASSISTANT_DISPLAY_NAME_KEY, DEFAULT_ASSISTANT_DISPLAY_NAME)),
);
export const assistantDisplayNameAtom = atom(
  (get) => get(assistantDisplayNameBaseAtom),
  (_get, set, next: string) => {
    const value = normalizeAssistantDisplayName(next);
    set(assistantDisplayNameBaseAtom, value);
    if (value === DEFAULT_ASSISTANT_DISPLAY_NAME) {
      writeUiValue(ASSISTANT_DISPLAY_NAME_KEY, "");
    } else {
      writeUiValue(ASSISTANT_DISPLAY_NAME_KEY, value);
    }
  },
);

const assistantAvatarDataUrlBaseAtom = atom<string>(
  normalizeAssistantAvatarDataUrl(readUiValue(ASSISTANT_AVATAR_KEY, "")),
);
export const assistantAvatarDataUrlAtom = atom(
  (get) => get(assistantAvatarDataUrlBaseAtom),
  (_get, set, next: string) => {
    const value = normalizeAssistantAvatarDataUrl(next);
    set(assistantAvatarDataUrlBaseAtom, value);
    writeUiValue(ASSISTANT_AVATAR_KEY, value);
  },
);

/** 展示用头像：用户未自定义（存储为空）时回退到内置默认头像。
 *  设置页请继续用 assistantAvatarDataUrlAtom（空=未设置 的原语义）。 */
export const assistantAvatarEffectiveAtom = atom(
  (get) => get(assistantAvatarDataUrlBaseAtom) || hermesDefaultAvatar,
);

const showReasoningBaseAtom = atom<boolean>(readUiValue("hermes.show-reasoning", false));
export const showReasoningAtom = atom(
  (get) => get(showReasoningBaseAtom),
  (_get, set, next: boolean) => {
    set(showReasoningBaseAtom, next);
    writeUiValue("hermes.show-reasoning", next);
  },
);

// 匿名使用统计开关（默认开启）。发送端在 lib/telemetry.ts 直接读 ui-store，
// 这个 atom 只服务设置页 UI。key 与 lib/telemetry.ts 的 TELEMETRY_ENABLED_KEY 一致。
const TELEMETRY_ENABLED_UI_KEY = "hermes.telemetry-enabled";
const telemetryEnabledBaseAtom = atom<boolean>(readUiValue<unknown>(TELEMETRY_ENABLED_UI_KEY, true) !== false);
export const telemetryEnabledAtom = atom(
  (get) => get(telemetryEnabledBaseAtom),
  (_get, set, next: boolean) => {
    set(telemetryEnabledBaseAtom, next);
    writeUiValue(TELEMETRY_ENABLED_UI_KEY, next);
  },
);

// Task-detail right rail (issue #233): rich preview panel visibility. Persisted
// so the user's last choice survives reload; ⌘B toggles it. The active tab
// lives in the `?panel=` query, not here (see lib/preview-rail.ts).
const RIGHT_RAIL_VISIBLE_KEY = "hermes.right-rail-visible";
const rightRailVisibleBaseAtom = atom<boolean>(readUiValue<unknown>(RIGHT_RAIL_VISIBLE_KEY, false) === true);
export const rightRailVisibleAtom = atom(
  (get) => get(rightRailVisibleBaseAtom),
  (_get, set, next: boolean) => {
    set(rightRailVisibleBaseAtom, next === true);
    writeUiValue(RIGHT_RAIL_VISIBLE_KEY, next === true);
  },
);

const COMPOSER_SUBMIT_SHORTCUT_KEY = "hermes.composer-submit-shortcut";

function normalizeComposerSubmitShortcut(value: unknown): ComposerSubmitShortcut {
  return value === "ctrl-enter" ? "ctrl-enter" : "enter";
}

const composerSubmitShortcutBaseAtom = atom<ComposerSubmitShortcut>(
  normalizeComposerSubmitShortcut(readUiValue(COMPOSER_SUBMIT_SHORTCUT_KEY, "enter")),
);
export const composerSubmitShortcutAtom = atom(
  (get) => get(composerSubmitShortcutBaseAtom),
  (_get, set, next: ComposerSubmitShortcut) => {
    const value = normalizeComposerSubmitShortcut(next);
    set(composerSubmitShortcutBaseAtom, value);
    writeUiValue(COMPOSER_SUBMIT_SHORTCUT_KEY, value);
  },
);

// 桌面通知设置（issue #194）。触发链路（stores/chat.ts → lib/notifications.ts）
// 不在 React 上下文里，直接通过 readNotificationSettings() 同步读 kv 缓存；
// atoms 写入时 writeUiValue 同步写穿同一缓存，两边天然一致。
const NOTIFY_SYSTEM_KEY = "hermes.notify-system";
const NOTIFY_SOUND_KEY = "hermes.notify-sound";
const NOTIFY_ON_COMPLETE_KEY = "hermes.notify-on-complete";
const NOTIFY_ON_APPROVAL_KEY = "hermes.notify-on-approval";
const NOTIFY_ONLY_BACKGROUND_KEY = "hermes.notify-only-background";

function readNotifyFlag(key: string): boolean {
  return readUiValue<unknown>(key, true) !== false;
}

function makeNotifyFlagAtom(key: string) {
  const baseAtom = atom<boolean>(readNotifyFlag(key));
  return atom(
    (get) => get(baseAtom),
    (_get, set, next: boolean) => {
      set(baseAtom, next === true);
      writeUiValue(key, next === true);
    },
  );
}

export const notifySystemAtom = makeNotifyFlagAtom(NOTIFY_SYSTEM_KEY);
export const notifySoundAtom = makeNotifyFlagAtom(NOTIFY_SOUND_KEY);
export const notifyOnCompleteAtom = makeNotifyFlagAtom(NOTIFY_ON_COMPLETE_KEY);
export const notifyOnApprovalAtom = makeNotifyFlagAtom(NOTIFY_ON_APPROVAL_KEY);
export const notifyOnlyBackgroundAtom = makeNotifyFlagAtom(NOTIFY_ONLY_BACKGROUND_KEY);

export interface NotificationSettings {
  system: boolean;
  sound: boolean;
  onComplete: boolean;
  onApproval: boolean;
  onlyBackground: boolean;
}

export function readNotificationSettings(): NotificationSettings {
  return {
    system: readNotifyFlag(NOTIFY_SYSTEM_KEY),
    sound: readNotifyFlag(NOTIFY_SOUND_KEY),
    onComplete: readNotifyFlag(NOTIFY_ON_COMPLETE_KEY),
    onApproval: readNotifyFlag(NOTIFY_ON_APPROVAL_KEY),
    onlyBackground: readNotifyFlag(NOTIFY_ONLY_BACKGROUND_KEY),
  };
}

// Set to true while the desktop main process is restarting the dashboard
// subprocess for a profile switch. The window-level overlay in ProfileSwitcherOverlay
// reads this and blocks UI interaction until the new dashboard is ready.
// Stays false in web mode (sticky-only switch is instant).
// `title`/`body` override the default profile-switch copy so the same overlay
// can mask any dashboard restart (e.g. toggling YOLO mode), since the user-
// facing concern ("don't panic at the transient errors") is identical.
export const profileSwitchingAtom = atom<{
  active: boolean;
  targetName?: string;
  title?: string;
  body?: string;
}>({
  active: false,
});

// Set to true while the desktop main process is installing a runtime update or
// rolling back. Like a profile switch, this stops + respawns the dashboard
// subprocess, during which every REST/WS call would otherwise hit a stale
// session token and surface a 401. The window-level RuntimeUpdateOverlay reads
// this and blocks UI interaction (and the polling queries behind it) until the
// new dashboard is ready and the token has been refreshed.
export const runtimeUpdatingAtom = atom<{ active: boolean; mode?: "install" | "rollback" }>({
  active: false,
});
