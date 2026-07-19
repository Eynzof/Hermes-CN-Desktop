export interface CommandPaletteShortcutEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}

export function isCommandPaletteShortcut(event: CommandPaletteShortcutEvent): boolean {
  if (event.isComposing) return false;
  if (event.key.toLowerCase() !== "k") return false;
  if (event.altKey || event.shiftKey) return false;
  return Boolean(event.metaKey || event.ctrlKey);
}
