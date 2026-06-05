export type ComposerSubmitShortcut = "enter" | "shift-enter";

export interface ComposerKeyState {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

export function shouldSubmitComposerKey(
  keyState: ComposerKeyState,
  shortcut: ComposerSubmitShortcut = "enter",
): boolean {
  if (keyState.isComposing || keyState.altKey || keyState.key !== "Enter") return false;
  return shortcut === "shift-enter" ? Boolean(keyState.shiftKey) : !keyState.shiftKey;
}

export function composerSubmitShortcutHint(shortcut: ComposerSubmitShortcut = "enter"): string {
  return shortcut === "shift-enter"
    ? "Shift+Enter 发送；Enter 换行"
    : "Enter 发送；Shift+Enter 换行";
}
