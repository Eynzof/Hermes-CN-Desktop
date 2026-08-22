// Context reference types.
// Mirrors the Python ContextReference contract from agent/context_references.py.

export type MentionKind = "file" | "folder" | "diff" | "staged" | "git" | "url";

export interface Mention {
  /** The exact text matched in the source message, e.g. `@file:src/main.ts:10-25`. */
  raw: string;
  kind: MentionKind;
  /** Kind-specific target/path/value (without the leading `@kind:`). */
  target: string;
  /** Start index of `raw` in the original message. */
  start: number;
  /** End index (exclusive) of `raw` in the original message. */
  end: number;
  /** 1-indexed inclusive line start for `@file:path:N-M`. */
  lineStart?: number;
  /** 1-indexed inclusive line end for `@file:path:N-M`. */
  lineEnd?: number;
}

export interface MentionResolution {
  mention: Mention;
  /** Resolved text block to inject, or `null` when blocked/missing. */
  text: string | null;
  /** Human-readable warnings to surface to the user. */
  warnings: string[];
  /** Estimated tokens contributed by `text` (0 when null). */
  tokens: number;
}

export interface ExpandOptions {
  /** Workspace root used for file/folder containment and git cwd. */
  cwd: string;
  /** Model context length used for soft/hard budget checks. */
  contextLength: number;
  /** Optional override for the allowed filesystem root (defaults to `cwd`). */
  allowedRoot?: string;
  /** Optional custom fetcher for `@url` (defaults to the Rust `http_fetch_safe` command). */
  fetchUrl?: (url: string) => Promise<{ ok: boolean; text: string; error?: string }>;
  /** Optional custom file reader (defaults to Rust `read_workspace_file`). */
  readFile?: (path: string, root: string) => Promise<FilePreviewLike>;
  /** Optional custom folder lister (defaults to Rust `context_refs_folder_list`). */
  listFolder?: (path: string, root: string) => Promise<FolderListResult>;
  /** Optional custom git runner (defaults to Rust `context_refs_git_capture`). */
  gitCapture?: (args: string[], cwd: string) => Promise<GitCaptureResult>;
}

export interface FilePreviewLike {
  text?: string | null;
  dataUrl?: string | null;
  byteSize: number;
  binary: boolean;
  truncated: boolean;
}

export interface FolderListResult {
  entries: FolderEntry[];
  truncated: boolean;
}

export interface FolderEntry {
  path: string;
  isDir: boolean;
}

export interface GitCaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExpandResult {
  message: string;
  originalMessage: string;
  mentions: Mention[];
  warnings: string[];
  injectedTokens: number;
  expanded: boolean;
  blocked: boolean;
}
