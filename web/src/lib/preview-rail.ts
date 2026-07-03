// Pure helpers for the task-detail right rail (issue #233). Kept free of React
// so the panel routing, language detection, and content framing are unit
// testable in isolation.

import type { FilePreview } from "./runtime";

export const PREVIEW_PANELS = ["web", "files", "terminal", "logs"] as const;
export type PreviewPanel = (typeof PREVIEW_PANELS)[number];
export const DEFAULT_PREVIEW_PANEL: PreviewPanel = "files";

/** The `?panel=` query key used to deep-link the active rail tab. */
export const PREVIEW_PANEL_QUERY_KEY = "panel";

export function normalizePreviewPanel(value: unknown): PreviewPanel {
  return PREVIEW_PANELS.includes(value as PreviewPanel)
    ? (value as PreviewPanel)
    : DEFAULT_PREVIEW_PANEL;
}

// Extension → fenced-code language id (Streamdown/Shiki). Only the common cases
// the preview needs; unknown extensions fall back to no language (plain mono).
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  lua: "lua",
  dockerfile: "dockerfile",
};

const MARKDOWN_EXT = new Set(["md", "markdown", "mdx", "mdc"]);

export function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function detectLanguage(path: string): string | undefined {
  return LANGUAGE_BY_EXT[fileExtension(path)];
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXT.has(fileExtension(path));
}

/**
 * Wrap raw file content in a markdown fenced code block for the existing
 * `MarkdownText` renderer (Streamdown handles fence highlighting + a copy
 * button). The fence is made one backtick longer than the longest backtick
 * run in the content so embedded fences can't break out of the block.
 */
export function toFencedMarkdown(text: string, language?: string): string {
  let longestRun = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === "`") {
      current += 1;
      if (current > longestRun) longestRun = current;
    } else {
      current = 0;
    }
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language ?? ""}\n${text}\n${fence}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** Best-effort check that a string is an http(s) URL safe for the preview iframe. */
export function isPreviewableUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export interface Breadcrumb {
  /** Display label for this segment. */
  label: string;
  /** Absolute path this segment navigates to. */
  path: string;
}

/**
 * Split an absolute directory into clickable breadcrumb segments, each carrying
 * the absolute path to navigate to. Supports POSIX (`/Users/Enzo/Documents`)
 * and Windows (`C:\Users\Enzo`) paths. The POSIX root is its own `/` segment.
 */
export function buildBreadcrumbs(dir: string): Breadcrumb[] {
  const trimmed = (dir ?? "").trim();
  if (!trimmed) return [];

  // Windows: drive-letter root (C:\ or C:/).
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    const parts = trimmed.split(/[\\/]+/).filter(Boolean); // ["C:", "Users", ...]
    return parts.map((label, index) => ({
      label,
      path: index === 0 ? `${parts[0]}\\` : `${parts[0]}\\${parts.slice(1, index + 1).join("\\")}`,
    }));
  }

  // POSIX: leading "/" root, then each component.
  const parts = trimmed.split("/").filter(Boolean);
  const crumbs: Breadcrumb[] = [{ label: "/", path: "/" }];
  parts.forEach((label, index) => {
    crumbs.push({ label, path: `/${parts.slice(0, index + 1).join("/")}` });
  });
  return crumbs;
}

/**
 * Parent of an absolute directory, or `null` at the filesystem root. Reuses
 * {@link buildBreadcrumbs} so POSIX and Windows splitting stay in one place —
 * the parent is simply the second-to-last breadcrumb. Used to drive the ".."
 * control client-side now that `/api/fs/list` no longer returns `parent`.
 */
export function parentDir(dir: string): string | null {
  const crumbs = buildBreadcrumbs(dir);
  return crumbs.length >= 2 ? crumbs[crumbs.length - 2].path : null;
}

/**
 * Human message for a `/api/fs/list` failure. `code` is the upstream HTTP-200
 * soft-error string (errno-style); `undefined` covers transport/HTTP failures
 * surfaced via TanStack Query's `isError`.
 */
export function fsListErrorText(code?: string | null): string {
  switch (code) {
    case "ENOENT":
      return "目录不存在。";
    case "EACCES":
      return "无权限访问此目录。";
    case "ENOTDIR":
      return "这不是一个目录。";
    default:
      return "无法读取此目录，请稍后重试。";
  }
}

// ── Spot editor (in-place file editing, issue #326) ──────────────────────────

/**
 * Whether the spot editor may edit this preview. Only whole, readable text is
 * editable — never images (`dataUrl`), binaries, files we only loaded the
 * first 512 KB of (`truncated`), or non-UTF-8 files whose text is a lossy
 * rendering (`lossyUtf8`), since saving those would corrupt or drop data.
 * Mirrors the upstream `canEdit` guard. The caller additionally gates on the
 * native write bridge being present (absent in the browser fallback).
 */
export function canEditPreview(preview: FilePreview | null): boolean {
  return (
    preview != null &&
    !preview.binary &&
    !preview.dataUrl &&
    !preview.truncated &&
    !preview.lossyUtf8 &&
    preview.text !== undefined
  );
}

/**
 * Stale-on-disk guard for save: did the file diverge from the snapshot the
 * editor started from? `current` is a fresh read just before writing; `baseline`
 * is the text captured when editing began. A binary re-read means the file was
 * replaced with something that is no longer the edited text, so it is always a
 * conflict. Mirrors the upstream `saveEdit` pre-write check.
 */
export function isStaleOnDisk(current: FilePreview, baseline: string): boolean {
  return current.binary || (current.text ?? "") !== baseline;
}

/** Shared confirm() copy for every action that would drop an unsaved draft. */
export const UNSAVED_DISCARD_CONFIRM = "有未保存的修改，确定放弃吗？";

// ── Line-ending preservation ─────────────────────────────────────────────────
// A <textarea> normalizes CRLF/CR to LF in its `value`, so a CRLF file edited
// as-is would be silently rewritten to LF on save. These helpers detect the
// baseline style when editing begins and restore it just before writing.

/** Line-ending style of a text buffer. */
export type EolStyle = "\n" | "\r\n";

/**
 * Detect the dominant line-ending style of `text`. Mixed files take the
 * majority side (ties favor LF); a file without line breaks is LF.
 */
export function detectEol(text: string): EolStyle {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "\n") continue;
    if (text[i - 1] === "\r") crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Normalize CRLF / lone-CR line endings to LF — the same normalization a
 * <textarea> applies — so dirty checks compare both sides on equal footing.
 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Re-apply a detected line-ending style to an (LF-normalized) buffer before
 * writing. LF passes through untouched; CRLF normalizes first (defensive for
 * mixed input) and then expands every LF.
 */
export function restoreEol(text: string, eol: EolStyle): string {
  if (eol === "\n") return text;
  return normalizeEol(text).replace(/\n/g, "\r\n");
}
