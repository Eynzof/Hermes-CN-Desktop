/**
 * Composer prompt history — TUI parity layer.
 *
 * The original TUI stores multiline entries in `~/.hermes/.hermes_history`
 * (`ui-tui/src/lib/history.ts`) with a `+` continuation prefix and a 1000-entry
 * cap. In the desktop webview we do not have direct FS access, so this module
 * persists the same logical format through the UI store (`hermes.input-history`).
 * A Rust-backed FS adapter can be injected later without changing consumers.
 */
import { readUiValue, writeUiValue } from "./ui-store";

export const COMPOSER_INPUT_HISTORY_KEY = "hermes.composer-input-history";
export const DEFAULT_INPUT_HISTORY_CAP = 1000;

export interface InputHistoryEntry {
  /** Single- or multi-line prompt text (newlines preserved). */
  text: string;
  /** ISO timestamp when the entry was recorded. */
  savedAt: string;
}

export interface InputHistory {
  entries: InputHistoryEntry[];
  /** Format version for future migrations. */
  version: number;
}

export interface InputHistoryAdapter {
  load(): InputHistory;
  save(history: InputHistory): void;
}

function emptyHistory(): InputHistory {
  return { entries: [], version: 1 };
}

function migrate(value: unknown): InputHistory {
  if (!value || typeof value !== "object") return emptyHistory();
  const candidate = value as Partial<InputHistory>;
  if (!Array.isArray(candidate.entries)) return emptyHistory();
  return {
    entries: candidate.entries.filter(
      (entry): entry is InputHistoryEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as InputHistoryEntry).text === "string" &&
        typeof (entry as InputHistoryEntry).savedAt === "string",
    ),
    version: typeof candidate.version === "number" ? candidate.version : 1,
  };
}

export function createUiStoreInputHistoryAdapter(): InputHistoryAdapter {
  return {
    load() {
      return migrate(readUiValue<unknown>(COMPOSER_INPUT_HISTORY_KEY, null));
    },
    save(history) {
      writeUiValue(COMPOSER_INPUT_HISTORY_KEY, history);
    },
  };
}

/** Append a prompt to the front of the history, deduping the previous entry. */
export function addInputHistoryEntry(
  history: InputHistory,
  text: string,
  opts: { cap?: number; now?: Date } = {},
): InputHistory {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return history;
  const cap = opts.cap ?? DEFAULT_INPUT_HISTORY_CAP;
  const now = opts.now ?? new Date();

  const withoutDup =
    history.entries[0]?.text === trimmed
      ? history.entries.slice(1)
      : history.entries;

  return {
    version: history.version,
    entries: [{ text: trimmed, savedAt: now.toISOString() }, ...withoutDup].slice(0, cap),
  };
}

/** Find the next/previous history entry matching an optional prefix. */
export function recallInputHistory(
  history: InputHistory,
  direction: "older" | "newer",
  current: string,
  cursor: { index: number; inline: string },
): { text: string; cursor: { index: number; inline: string } } | null {
  const prefix = cursor.inline.trim();
  const entries = history.entries;
  if (entries.length === 0) return null;

  const startIndex = cursor.index < 0 || cursor.index >= entries.length ? -1 : cursor.index;
  const step = direction === "older" ? 1 : -1;

  let index = startIndex;
  while (true) {
    index += step;
    if (index < -1 || index >= entries.length) return null;
    if (index === -1) {
      // Returned past the newest entry — restore the inline draft.
      return { text: current, cursor: { index: -1, inline: prefix } };
    }
    if (!prefix || entries[index]!.text.toLowerCase().startsWith(prefix.toLowerCase())) {
      return { text: entries[index]!.text, cursor: { index, inline: prefix } };
    }
  }
}

/** Serialize history to the TUI `+`-prefixed multiline format. */
export function serializeInputHistory(history: InputHistory): string {
  return history.entries
    .map((entry) =>
      entry.text
        .split("\n")
        .map((line, idx) => (idx === 0 ? line : `+${line}`))
        .join("\n"),
    )
    .join("\n");
}

/** Parse the TUI `+`-prefixed multiline format. */
export function parseInputHistory(raw: string): InputHistory {
  const lines = raw.split("\n");
  const entries: InputHistoryEntry[] = [];
  let buffer: string[] = [];
  const now = new Date().toISOString();

  for (const line of lines) {
    if (line.startsWith("+")) {
      buffer.push(line.slice(1));
    } else {
      if (buffer.length) {
        const text = buffer.join("\n");
        if (text.trim()) entries.push({ text, savedAt: now });
      }
      buffer = [line];
    }
  }
  if (buffer.length) {
    const text = buffer.join("\n");
    if (text.trim()) entries.push({ text, savedAt: now });
  }
  return { entries, version: 1 };
}

export function createInputHistoryManager(
  adapter: InputHistoryAdapter = createUiStoreInputHistoryAdapter(),
  cap = DEFAULT_INPUT_HISTORY_CAP,
) {
  let history = adapter.load();

  function persist() {
    adapter.save(history);
  }

  return {
    getHistory(): InputHistory {
      return history;
    },
    reload() {
      history = adapter.load();
    },
    push(text: string, now?: Date) {
      history = addInputHistoryEntry(history, text, { cap, now });
      persist();
    },
    recall(
      direction: "older" | "newer",
      current: string,
      cursor: { index: number; inline: string },
    ) {
      return recallInputHistory(history, direction, current, cursor);
    },
    clear() {
      history = emptyHistory();
      persist();
    },
    toTuiFormat() {
      return serializeInputHistory(history);
    },
    importTuiFormat(raw: string) {
      history = parseInputHistory(raw);
      persist();
    },
  };
}

export type InputHistoryManager = ReturnType<typeof createInputHistoryManager>;
