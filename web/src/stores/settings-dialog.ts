import { atom } from "jotai";

/**
 * 设置弹窗（WorkBuddy 范式）的打开状态与当前面板。
 * 旧路由 /settings/<pane> 深链命中时打开主界面并自动弹出对应面板。
 */
export type SettingsPane =
  | "account"
  | "system"
  | "agent"
  | "shortcuts"
  | "memory"
  | "model"
  | "assistant"
  | "personal"
  | "data"
  | "security"
  | "advanced"
  | "observe"
  | "help";

export const SETTINGS_PANES: readonly SettingsPane[] = [
  "account",
  "system",
  "agent",
  "shortcuts",
  "memory",
  "model",
  "assistant",
  "personal",
  "data",
  "security",
  "advanced",
  "observe",
  "help",
];

export function normalizeSettingsPane(value: string | null | undefined): SettingsPane {
  return SETTINGS_PANES.find((pane) => pane === value) ?? "system";
}

/** 旧路由路径 → 弹窗面板（兼容旧书签与通知点击跳转） */
export const LEGACY_PATH_TO_PANE: Record<string, SettingsPane> = {
  "/profiles": "account",
  "/connection": "account",
  "/common": "system",
  "/notifications": "system",
  "/soul": "agent",
  "/coding-agents": "agent",
  "/voice": "agent",
  "/memory": "memory",
  "/models": "model",
  "/im": "assistant",
  "/theme": "personal",
  "/backup": "data",
  "/config-migration": "data",
  "/config": "advanced",
  "/kernel": "advanced",
  "/env": "advanced",
  "/console": "advanced",
  "/health": "observe",
  "/analytics": "observe",
  "/logs": "observe",
  "/debug": "observe",
  "/about": "help",
};

export const settingsDialogOpenAtom = atom<boolean>(false);

export const settingsDialogPaneAtom = atom<SettingsPane>("system");

/** 打开设置弹窗并定位到指定面板。 */
export const openSettingsDialogAtom = atom(null, (_get, set, pane?: SettingsPane) => {
  if (pane) set(settingsDialogPaneAtom, pane);
  set(settingsDialogOpenAtom, true);
});
