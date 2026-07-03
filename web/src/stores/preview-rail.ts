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

// True while the Files tab's spot editor holds unsaved changes. Readers:
// preview-rail.tsx renders a VS Code-style "modified" dot on the 文件 tab and
// confirms before a tab switch unmounts the editor; file-preview-tab.tsx
// confirms before switching to another file. Note the dot is only ever visible
// while the 文件 tab itself is active — switching away unmounts FilePreviewTab,
// which either got confirmed (draft discarded, atom cleared on unmount) or was
// blocked, so a dirty dot can never linger on an inactive tab. Mirrors the
// upstream `$dirtyPreviewUrls`; one preview rail is visible at a time, so a
// single boolean is enough. The editor in file-preview-tab.tsx is the sole
// writer.
export const previewEditorDirtyAtom = atom(false);
