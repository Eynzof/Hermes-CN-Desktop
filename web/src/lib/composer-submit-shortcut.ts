export type ComposerSubmitShortcut = "enter" | "ctrl-enter";

export interface ComposerKeyState {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

export function shouldSubmitComposerKey(
  keyState: ComposerKeyState,
  shortcut: ComposerSubmitShortcut = "enter",
): boolean {
  if (keyState.isComposing || keyState.altKey || keyState.key !== "Enter") return false;

  if (shortcut === "ctrl-enter") {
    return Boolean(keyState.ctrlKey) && !keyState.shiftKey;
  }

  return !keyState.shiftKey && !keyState.ctrlKey;
}

export function composerSubmitShortcutHint(shortcut: ComposerSubmitShortcut = "enter"): string {
  return shortcut === "ctrl-enter"
    ? "Ctrl+Enter 发送；Enter 换行"
    : "Enter 发送；Shift+Enter 换行";
}
