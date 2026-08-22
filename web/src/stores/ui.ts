import { atom } from "jotai";
import type { ComposerSubmitShortcut } from "@/lib/composer-submit-shortcut";
import { normalizeBusyMode, type ComposerBusyMode } from "@/lib/composer-busy-mode";
import { readUiValue, removeUiValue, subscribeUiStore, writeUiValue } from "@/lib/ui-store";
import hermesDefaultAvatar from "@/assets/hermes-default-avatar.png";

function persistedUiBaseAtom<T>(read: () => T) {
  const baseAtom = atom<T>(read());
  baseAtom.onMount = (setValue) => {
    const syncFromUiStore = () => setValue(read());
    syncFromUiStore();
    return subscribeUiStore(syncFromUiStore);
  };
  return baseAtom;
}

const ACTIVE_SESSION_ID_KEY = "hermes.active-session-id";

const activeSessionIdBaseAtom = persistedUiBaseAtom<string | null>(
  () => readUiValue<string | null>(ACTIVE_SESSION_ID_KEY, null),
);

/**
 * Tracks the currently-active session ID across the UI (sidebar highlight,
 * detail route target, gateway resume). Persisted to the UI store so it
 * survives page refresh (F5) on non-detail routes (e.g., the Panel page).
 *
 * On detail routes the URL (`/tasks/:taskId`) provides recovery, but the
 * atom is the single source of truth at runtime — sidebar/history/panel
 * clicks update it synchronously before navigating (see issue #53).
 *
 * Setting to `null` short-circuits the persisted key (via removeUiValue)
 * so a stale session ID doesn't linger after the user has explicitly
 * cleared their active context.
 */
export const activeSessionIdAtom = atom(
  (get) => get(activeSessionIdBaseAtom),
  (_get, set, next: string | null) => {
    set(activeSessionIdBaseAtom, next);
    if (next) {
      writeUiValue(ACTIVE_SESSION_ID_KEY, next);
    } else {
      removeUiValue(ACTIVE_SESSION_ID_KEY);
    }
  },
);

// Maps a pre-compression persistent session id to the live continuation "tip"
// that the backend redirected a `session.resume` to. The detail route watches
// this so the URL/active id follows the backend's new tip after compression
// instead of stranding the user on a session whose messages have moved — the
// "conversation vanished + #2/#3 duplicate" symptom (issue #305). Populated by
// resumeSession via recordTipRedirect; consumed by the detail route effect.
export const sessionTipRedirectAtom = atom<Record<string, string>>({});

const SIDEBAR_SEARCH_KEY = "hermes.sidebar-search";

function readSidebarSearch(): string {
  if (typeof sessionStorage === "undefined") return "";
  try {
    return sessionStorage.getItem(SIDEBAR_SEARCH_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeSidebarSearch(value: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (value) {
      sessionStorage.setItem(SIDEBAR_SEARCH_KEY, value);
    } else {
      sessionStorage.removeItem(SIDEBAR_SEARCH_KEY);
    }
  } catch {}
}

const sidebarSearchBaseAtom = atom<string>(readSidebarSearch());

export const sidebarSearchAtom = atom(
  (get) => get(sidebarSearchBaseAtom),
  (_get, set, next: string) => {
    set(sidebarSearchBaseAtom, next);
    writeSidebarSearch(next);
  },
);
export const commandPaletteOpenAtom = atom(false);

const APP_SIDEBAR_VISIBLE_KEY = "hermes.app-sidebar-visible";
const appSidebarVisibleBaseAtom = persistedUiBaseAtom<boolean>(
  () => readUiValue<unknown>(APP_SIDEBAR_VISIBLE_KEY, true) !== false,
);
export const appSidebarVisibleAtom = atom(
  (get) => get(appSidebarVisibleBaseAtom),
  (_get, set, next: boolean) => {
    const visible = next === true;
    set(appSidebarVisibleBaseAtom, visible);
    writeUiValue(APP_SIDEBAR_VISIBLE_KEY, visible);
  },
);

export const CONVERSATION_WIDTH_OPTIONS = [
  // 档位整体上调一档（用户反馈原「小/中」过窄）：大 = 960 + 头像列
  // 46px（36px 头像 + 10px gap），正文有效宽度与原「大」一致。
  { value: "small", label: "小", title: "小宽度", maxWidth: "780px" },
  { value: "medium", label: "中", title: "中等宽度", maxWidth: "960px" },
  { value: "large", label: "大", title: "大宽度", maxWidth: "1008px" },
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

const conversationWidthModeBaseAtom = persistedUiBaseAtom<ConversationWidthMode>(
  () => normalizeConversationWidthMode(readUiValue(CONVERSATION_WIDTH_KEY, DEFAULT_CONVERSATION_WIDTH_MODE)),
);
export const conversationWidthModeAtom = atom(
  (get) => get(conversationWidthModeBaseAtom),
  (_get, set, next: ConversationWidthMode) => {
    const value = normalizeConversationWidthMode(next);
    set(conversationWidthModeBaseAtom, value);
    writeUiValue(CONVERSATION_WIDTH_KEY, value);
  },
);

const conversationFontSizeBaseAtom = persistedUiBaseAtom<ConversationFontSizeMode>(
  () => normalizeConversationFontSizeMode(readUiValue(CONVERSATION_FONT_SIZE_KEY, DEFAULT_CONVERSATION_FONT_SIZE_MODE)),
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
const activeProfileBaseAtom = persistedUiBaseAtom<string>(
  () => readUiValue("hermes.active-profile", "default"),
);
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

const assistantDisplayNameBaseAtom = persistedUiBaseAtom<string>(
  () => normalizeAssistantDisplayName(readUiValue(ASSISTANT_DISPLAY_NAME_KEY, DEFAULT_ASSISTANT_DISPLAY_NAME)),
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

const assistantAvatarDataUrlBaseAtom = persistedUiBaseAtom<string>(
  () => normalizeAssistantAvatarDataUrl(readUiValue(ASSISTANT_AVATAR_KEY, "")),
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

const showReasoningBaseAtom = persistedUiBaseAtom<boolean>(
  () => readUiValue("hermes.show-reasoning", false),
);
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
const telemetryEnabledBaseAtom = persistedUiBaseAtom<boolean>(
  () => readUiValue<unknown>(TELEMETRY_ENABLED_UI_KEY, true) !== false,
);
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
const rightRailVisibleBaseAtom = persistedUiBaseAtom<boolean>(
  () => readUiValue<unknown>(RIGHT_RAIL_VISIBLE_KEY, false) === true,
);
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

const composerSubmitShortcutBaseAtom = persistedUiBaseAtom<ComposerSubmitShortcut>(
  () => normalizeComposerSubmitShortcut(readUiValue(COMPOSER_SUBMIT_SHORTCUT_KEY, "ctrl-enter")),
);
export const composerSubmitShortcutAtom = atom(
  (get) => get(composerSubmitShortcutBaseAtom),
  (_get, set, next: ComposerSubmitShortcut) => {
    const value = normalizeComposerSubmitShortcut(next);
    set(composerSubmitShortcutBaseAtom, value);
    writeUiValue(COMPOSER_SUBMIT_SHORTCUT_KEY, value);
  },
);

// TUI parity: focus view suppresses tool-progress lines and adds a status-bar
// segment. Persisted so the user's preference survives reload.
const FOCUS_VIEW_ENABLED_KEY = "hermes.focus-view-enabled";
const focusViewEnabledBaseAtom = persistedUiBaseAtom<boolean>(
  () => readUiValue<unknown>(FOCUS_VIEW_ENABLED_KEY, false) === true,
);
export const focusViewEnabledAtom = atom(
  (get) => get(focusViewEnabledBaseAtom),
  (_get, set, next: boolean) => {
    const value = next === true;
    set(focusViewEnabledBaseAtom, value);
    writeUiValue(FOCUS_VIEW_ENABLED_KEY, value);
  },
);

// TUI parity: composer busy mode controls what happens when the agent is busy
// and the user submits another prompt. `interrupt` (default) stops the current
// turn; `queue` enqueues the prompt; `steer` sends it as a steering message.
const BUSY_MODE_KEY = "hermes.composer-busy-mode";
const busyModeBaseAtom = persistedUiBaseAtom<ComposerBusyMode>(
  () => normalizeBusyMode(readUiValue(BUSY_MODE_KEY, "interrupt")),
);
export const busyModeAtom = atom(
  (get) => get(busyModeBaseAtom),
  (_get, set, next: ComposerBusyMode) => {
    const value = normalizeBusyMode(next);
    set(busyModeBaseAtom, value);
    writeUiValue(BUSY_MODE_KEY, value);
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
  const baseAtom = persistedUiBaseAtom<boolean>(() => readNotifyFlag(key));
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

/**
 * Re-read all persisted atoms from the UI store's current kvCache.
 *
 * Call this AFTER `initUiStore()` completes to ensure atoms reflect
 * persisted values even if they were created at module-import time
 * before the UI store was initialized (the F5 refresh race).
 *
 * For writable atoms created via `makeNotifyFlagAtom` (whose private
 * base atoms are not accessible), we call `store.set()` on the exported
 * atom — the write handler is idempotent for values already in kvCache.
 *
 * This function is safe to call multiple times; it only updates atoms
 * whose current value differs from the persisted value.
 */
export function hydratePersistedUiAtoms(store: ReturnType<typeof import("jotai/vanilla")["createStore"]>): void {
  type JotaiStore = typeof store;

  // 1. Conversation width
  const width = readUiValue(CONVERSATION_WIDTH_KEY, undefined);
  if (width !== undefined) {
    const normalized = normalizeConversationWidthMode(width);
    if (store.get(conversationWidthModeBaseAtom) !== normalized) {
      store.set(conversationWidthModeBaseAtom as any, normalized);
    }
  }

  // 2. Conversation font size
  const fontSize = readUiValue(CONVERSATION_FONT_SIZE_KEY, undefined);
  if (fontSize !== undefined) {
    const normalized = normalizeConversationFontSizeMode(fontSize);
    if (store.get(conversationFontSizeBaseAtom) !== normalized) {
      store.set(conversationFontSizeBaseAtom as any, normalized);
    }
  }

  // 3. Active profile
  const profile = readUiValue<string | undefined>("hermes.active-profile", undefined);
  if (profile !== undefined && typeof profile === "string") {
    if (store.get(activeProfileBaseAtom) !== profile) {
      store.set(activeProfileBaseAtom as any, profile);
    }
  }

  // 4. Assistant display name
  const displayName = readUiValue<string | undefined>(ASSISTANT_DISPLAY_NAME_KEY, undefined);
  if (displayName !== undefined) {
    const normalized = normalizeAssistantDisplayName(displayName);
    if (store.get(assistantDisplayNameBaseAtom) !== normalized) {
      store.set(assistantDisplayNameBaseAtom as any, normalized);
    }
  }

  // 5. Assistant avatar
  const avatar = readUiValue<string | undefined>(ASSISTANT_AVATAR_KEY, undefined);
  if (avatar !== undefined) {
    const normalized = normalizeAssistantAvatarDataUrl(avatar);
    if (store.get(assistantAvatarDataUrlBaseAtom) !== normalized) {
      store.set(assistantAvatarDataUrlBaseAtom as any, normalized);
    }
  }

  // 6. Show reasoning
  const showReasoning = readUiValue<unknown>("hermes.show-reasoning", undefined);
  if (showReasoning !== undefined) {
    const enabled = showReasoning === true;
    if (store.get(showReasoningBaseAtom) !== enabled) {
      store.set(showReasoningBaseAtom as any, enabled);
    }
  }

  // 7. Telemetry enabled
  const telemetry = readUiValue<unknown>(TELEMETRY_ENABLED_UI_KEY, undefined);
  if (telemetry !== undefined) {
    const enabled = telemetry !== false;
    if (store.get(telemetryEnabledBaseAtom) !== enabled) {
      store.set(telemetryEnabledBaseAtom as any, enabled);
    }
  }

  // 8. Right rail visible
  const rightRail = readUiValue<unknown>(RIGHT_RAIL_VISIBLE_KEY, undefined);
  if (rightRail !== undefined) {
    const visible = rightRail === true;
    if (store.get(rightRailVisibleBaseAtom) !== visible) {
      store.set(rightRailVisibleBaseAtom as any, visible);
    }
  }

  // 9. Composer submit shortcut
  const shortcut = readUiValue<unknown>(COMPOSER_SUBMIT_SHORTCUT_KEY, undefined);
  if (shortcut !== undefined) {
    const normalized = normalizeComposerSubmitShortcut(shortcut);
    if (store.get(composerSubmitShortcutBaseAtom) !== normalized) {
      store.set(composerSubmitShortcutBaseAtom as any, normalized);
    }
  }

  // 10. Active session ID — use exported atom (write handler handles set/null)
  const activeSessionId = readUiValue<string | null | undefined>(ACTIVE_SESSION_ID_KEY, undefined);
  // We read the store's current value from the exported atom's getter, not
  // the private base atom, because the exported atom layers on top of the base.
  // For null comparison we check if the stored value is explicitly null vs absent.
  if (activeSessionId !== undefined) {
    const current = store.get(activeSessionIdAtom);
    if (current !== activeSessionId) {
      store.set(activeSessionIdAtom, activeSessionId);
    }
  }

  // 11-15. Notification flags — use exported atoms (write handler is idempotent)
  const notifyKeys: Array<{ atom: any; key: string }> = [
    { atom: notifySystemAtom, key: NOTIFY_SYSTEM_KEY },
    { atom: notifySoundAtom, key: NOTIFY_SOUND_KEY },
    { atom: notifyOnCompleteAtom, key: NOTIFY_ON_COMPLETE_KEY },
    { atom: notifyOnApprovalAtom, key: NOTIFY_ON_APPROVAL_KEY },
    { atom: notifyOnlyBackgroundAtom, key: NOTIFY_ONLY_BACKGROUND_KEY },
  ];
  for (const { atom: notifAtom, key } of notifyKeys) {
    const stored = readUiValue<unknown>(key, undefined);
    if (stored !== undefined) {
      const enabled = stored !== false;
      if (store.get(notifAtom) !== enabled) {
        store.set(notifAtom, enabled);
      }
    }
  }
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

// Set to true while the desktop main process is installing a runtime update,
// rolling back, hot-updating the dev-source backend, or running the unified
// app update (frontend + backend at one version). Like a profile switch, these
// stop + respawn the dashboard subprocess, during which every REST/WS call
// would otherwise hit a stale session token and surface a 401. The window-level
// RuntimeUpdateOverlay reads this and blocks UI interaction (and the polling
// queries behind it) until the new dashboard is ready and the token has been
// refreshed.
export type RuntimeUpdatingMode = "install" | "rollback" | "hot-update" | "app-update" | "ui-update";

export interface RuntimeUpdatingState {
  active: boolean;
  mode?: RuntimeUpdatingMode;
  /** Progress lines streamed by `app-update-progress` / `hot-update-progress`
   * events. `percent` is present for app-update (0-100), absent for hot-update. */
  progress?: Array<{ phase: string; percent?: number; message: string }>;
}

export const runtimeUpdatingAtom = atom<RuntimeUpdatingState>({
  active: false,
});
