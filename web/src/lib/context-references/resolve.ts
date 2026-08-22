// Resolver for `@` context references.
// Bridges to Rust Tauri commands for filesystem, git, and safe URL fetch.

import { invokeCommand } from "../tauri-bridge";
import type {
  FilePreviewLike,
  FolderListResult,
  GitCaptureResult,
  Mention,
  MentionResolution,
} from "./types";

const MAX_GIT_N = 10;

export interface ResolverHooks {
  readFile: (path: string, root: string) => Promise<FilePreviewLike>;
  listFolder: (path: string, root: string) => Promise<FolderListResult>;
  gitCapture: (args: string[], cwd: string) => Promise<GitCaptureResult>;
  fetchUrl: (url: string) => Promise<{ ok: boolean; text: string; error?: string }>;
}

export interface ResolveContext {
  cwd: string;
  allowedRoot: string;
  hooks: ResolverHooks;
}

/** Resolve a single mention. Never throws — errors become warnings. */
export async function resolveMention(
  mention: Mention,
  ctx: ResolveContext,
): Promise<MentionResolution> {
  switch (mention.kind) {
    case "file":
      return resolveFile(mention, ctx);
    case "folder":
      return resolveFolder(mention, ctx);
    case "diff":
      return resolveGitDiff(mention, ctx);
    case "staged":
      return resolveGitStaged(mention, ctx);
    case "git":
      return resolveGitLog(mention, ctx);
    case "url":
      return resolveUrl(mention, ctx);
  }
}

async function resolveFile(mention: Mention, ctx: ResolveContext): Promise<MentionResolution> {
  if (!mention.target) {
    return warn(mention, "@file: 缺少文件路径");
  }
  try {
    const preview = await ctx.hooks.readFile(mention.target, ctx.allowedRoot);
    if (preview.binary) {
      return {
        mention,
        text: `📎 附件：二进制文件 \`${mention.target}\` (大小 ${preview.byteSize} 字节，无法内联显示)`,
        warnings: [`@file:${mention.target} 是二进制文件，已转为附件引用。`],
        tokens: estimateTokensRough(preview.text ?? ""),
      };
    }
    let text = preview.text ?? "";
    if (preview.truncated) {
      text += "\n\n[文件过大，已截断显示]";
    }
    if (mention.lineStart !== undefined) {
      const lines = text.split("\n");
      const startIdx = Math.max(0, mention.lineStart - 1);
      const endIdx = mention.lineEnd !== undefined ? Math.min(lines.length, mention.lineEnd) : lines.length;
      text = lines.slice(startIdx, endIdx).join("\n");
    }
    return {
      mention,
      text: wrapFileBlock(mention.target, text),
      warnings: [],
      tokens: estimateTokensRough(text),
    };
  } catch (error) {
    return warn(mention, `无法读取文件 \`${mention.target}\`：${formatError(error)}`);
  }
}

async function resolveFolder(mention: Mention, ctx: ResolveContext): Promise<MentionResolution> {
  if (!mention.target) {
    return warn(mention, "@folder: 缺少文件夹路径");
  }
  try {
    const result = await ctx.hooks.listFolder(mention.target, ctx.allowedRoot);
    const paths = result.entries.map((e) => (e.isDir ? `${e.path}/` : e.path));
    const truncatedNote = result.truncated ? "\n...（条目过多，仅列出前 200 项）" : "";
    const text = `📁 目录 \`${mention.target}\`：\n\n${paths.join("\n")}${truncatedNote}`;
    return {
      mention,
      text,
      warnings: result.truncated ? [`@folder:${mention.target} 条目过多，仅列出前 200 项。`] : [],
      tokens: estimateTokensRough(text),
    };
  } catch (error) {
    return warn(mention, `无法列出文件夹 \`${mention.target}\`：${formatError(error)}`);
  }
}

async function resolveGitDiff(mention: Mention, ctx: ResolveContext): Promise<MentionResolution> {
  const result = await ctx.hooks.gitCapture(["diff"], ctx.cwd);
  return gitResultToResolution(mention, result, "当前工作区 diff");
}

async function resolveGitStaged(mention: Mention, ctx: ResolveContext): Promise<MentionResolution> {
  const result = await ctx.hooks.gitCapture(["diff", "--staged"], ctx.cwd);
  return gitResultToResolution(mention, result, "已暂存 diff");
}

async function resolveGitLog(mention: Mention, ctx: ResolveContext): Promise<MentionResolution> {
  const raw = parseInt(mention.target, 10);
  const n = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_GIT_N) : 1;
  const result = await ctx.hooks.gitCapture(["log", `-${n}`, "-p"], ctx.cwd);
  return gitResultToResolution(mention, result, `最近 ${n} 条提交`);
}

async function resolveUrl(mention: Mention, ctx: ResolveContext): Promise<MentionResolution> {
  if (!mention.target) {
    return warn(mention, "@url: 缺少 URL");
  }
  try {
    const result = await ctx.hooks.fetchUrl(mention.target);
    if (!result.ok) {
      return warn(mention, `无法抓取 URL \`${mention.target}\`：${result.error || "未知错误"}`);
    }
    const text = result.text;
    return {
      mention,
      text: `🌐 网页内容 \`${mention.target}\`：\n\n${text}`,
      warnings: [],
      tokens: estimateTokensRough(text),
    };
  } catch (error) {
    return warn(mention, `抓取 URL \`${mention.target}\` 失败：${formatError(error)}`);
  }
}

function gitResultToResolution(
  mention: Mention,
  result: GitCaptureResult,
  label: string,
): MentionResolution {
  const text = result.stdout || "";
  const warnings: string[] = [];
  if (result.exitCode !== 0 && result.stderr) {
    warnings.push(`Git ${label} 返回非零退出码 ${result.exitCode}：${result.stderr.trim()}`);
  }
  if (!text.trim()) {
    warnings.push(`${label} 为空（可能不是 git 仓库或没有变更）。`);
  }
  return {
    mention,
    text: text ? `📝 ${label}：\n\n${text}` : null,
    warnings,
    tokens: estimateTokensRough(text),
  };
}

function warn(mention: Mention, message: string): MentionResolution {
  return {
    mention,
    text: null,
    warnings: [message],
    tokens: 0,
  };
}

function wrapFileBlock(path: string, content: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const fenceLang = CODE_FENCE_LANG[ext] ?? ext;
  return `📄 文件 \`${path}\`：\n\n\`\`\`${fenceLang}\n${content}\n\`\`\``;
}

const CODE_FENCE_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  js: "javascript",
  py: "python",
  rs: "rust",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  sh: "bash",
  bash: "bash",
  zsh: "zsh",
  css: "css",
  html: "html",
  sql: "sql",
  go: "go",
};

/** Rough token estimator (CJK-aware, ceiling division). */
export function estimateTokensRough(text: string): number {
  let tokens = 0;
  let asciiRun = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) || // Katakana
      (code >= 0xac00 && code <= 0xd7af) || // Hangul
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Ext A
      (code >= 0x20000 && code <= 0x2a6df); // CJK Ext B
    if (isCjk) {
      if (asciiRun > 0) {
        tokens += Math.ceil(asciiRun / 4);
        asciiRun = 0;
      }
      tokens += 1;
    } else {
      asciiRun += ch.length;
    }
  }
  if (asciiRun > 0) {
    tokens += Math.ceil(asciiRun / 4);
  }
  return tokens;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Default Rust-backed hooks for use in production. */
export function makeDefaultHooks(): ResolverHooks {
  return {
    readFile: async (path: string, root: string) => {
      return invokeCommand<FilePreviewLike>("read_workspace_file", { input: { path, root } });
    },
    listFolder: async (path: string, root: string) => {
      return invokeCommand<FolderListResult>("context_refs_folder_list", { input: { path, root } });
    },
    gitCapture: async (args: string[], cwd: string) => {
      return invokeCommand<GitCaptureResult>("context_refs_git_capture", { input: { args, cwd } });
    },
    fetchUrl: async (url: string) => {
      return invokeCommand<{ ok: boolean; text: string; error?: string }>("context_refs_http_fetch", { input: { url } });
    },
  };
}
