import { atom } from "jotai";
import type { ComposerSubmitShortcut } from "@/lib/composer-submit-shortcut";
import { readUiValue, writeUiValue } from "@/lib/ui-store";

export const activeSessionIdAtom = atom<string | null>(null);
export const sidebarSearchAtom = atom("");

export const CONVERSATION_WIDTH_OPTIONS = [
  { value: "small", label: "小", title: "小宽度", maxWidth: "640px" },
  { value: "medium", label: "中", title: "中等宽度", maxWidth: "780px" },
  { value: "large", label: "大", title: "大宽度", maxWidth: "960px" },
  { value: "full", label: "满", title: "铺满宽度", maxWidth: "100%" },
] as const;

export type ConversationWidthMode = typeof CONVERSATION_WIDTH_OPTIONS[number]["value"];

const DEFAULT_CONVERSATION_WIDTH_MODE: ConversationWidthMode = "medium";
const CONVERSATION_WIDTH_KEY = "hermes.conversation-width";
const CONVERSATION_WIDTH_VALUES = CONVERSATION_WIDTH_OPTIONS.map((option) => option.value);

export function normalizeConversationWidthMode(value: unknown): ConversationWidthMode {
  return CONVERSATION_WIDTH_VALUES.includes(value as ConversationWidthMode)
    ? (value as ConversationWidthMode)
    : DEFAULT_CONVERSATION_WIDTH_MODE;
}

export function conversationWidthMaxWidth(mode: ConversationWidthMode): string {
  return CONVERSATION_WIDTH_OPTIONS.find((option) => option.value === mode)?.maxWidth ?? "780px";
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

const showReasoningBaseAtom = atom<boolean>(readUiValue("hermes.show-reasoning", false));
export const showReasoningAtom = atom(
  (get) => get(showReasoningBaseAtom),
  (_get, set, next: boolean) => {
    set(showReasoningBaseAtom, next);
    writeUiValue("hermes.show-reasoning", next);
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
// subprocess, during which every REST/SSE/WS call would otherwise hit a stale
// session token and surface a 401. The window-level RuntimeUpdateOverlay reads
// this and blocks UI interaction (and the polling queries behind it) until the
// new dashboard is ready and the token has been refreshed.
export const runtimeUpdatingAtom = atom<{ active: boolean; mode?: "install" | "rollback" }>({
  active: false,
});
