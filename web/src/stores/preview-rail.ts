import { atom } from "jotai";

// Per-session selection for the task-detail right rail (issue #233). Kept in a
// map keyed by session id so toggling the rail (or switching tabs) preserves
// the chosen file / entered URL within a session. Ephemeral by design — not
// persisted to the UI store for the MVP.
export interface PreviewRailSelection {
  /** URL entered in the Web preview tab. */
  webUrl: string;
  /** Absolute path of the file selected in the Files tab. */
  filePath: string | null;
}

export const EMPTY_PREVIEW_RAIL_SELECTION: PreviewRailSelection = {
  webUrl: "",
  filePath: null,
};

export const previewRailSelectionMapAtom = atom<Record<string, PreviewRailSelection>>({});
