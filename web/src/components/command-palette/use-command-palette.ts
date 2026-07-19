import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { commandPaletteOpenAtom } from "@/stores/ui";

export function useCommandPalette() {
  const setOpen = useSetAtom(commandPaletteOpenAtom);
  const openCommandPalette = useCallback(() => setOpen(true), [setOpen]);
  const closeCommandPalette = useCallback(() => setOpen(false), [setOpen]);
  const toggleCommandPalette = useCallback(() => setOpen((open) => !open), [setOpen]);

  return { openCommandPalette, closeCommandPalette, toggleCommandPalette };
}
