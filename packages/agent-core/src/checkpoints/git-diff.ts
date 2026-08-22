import type { DiffRecord, DiffResult } from "./types.js";

/**
 * Abstraction over git read-only capture.
 *
 * The desktop supplies an implementation that forwards to Rust Tauri commands;
 * unit tests inject a fake. No implementation in this module mutates git state.
 */
export interface GitDiffProvider {
  /**
   * Return a status-like summary of `cwd` as diff records. Non-repos or
   * missing git should resolve to an empty array rather than throwing.
   */
  status(cwd: string): Promise<DiffRecord[]>;

  /**
   * Return a diff/stat record for `cwd`. If `ref` is omitted, the diff is
   * between the index and the working tree (uncommitted changes).
   */
  diff(cwd: string, opts?: { ref?: string; statOnly?: boolean }): Promise<DiffResult>;

  /**
   * Optional restore hook. When absent, the store performs session-message
   * rollback only and skips git working-tree restoration.
   */
  restore?(cwd: string, ref: string, filePath?: string): Promise<{ restored: boolean; message?: string }>;
}

/** Provider used when git capture is unavailable (browser/web test shims). */
export class NoopGitDiffProvider implements GitDiffProvider {
  async status(): Promise<DiffRecord[]> {
    return [];
  }

  async diff(): Promise<DiffResult> {
    return { empty: true, stat: [], diff: "" };
  }
}

/** In-memory fake for unit tests. */
export class FakeGitDiffProvider implements GitDiffProvider {
  private readonly statuses = new Map<string, DiffRecord[]>();
  private readonly diffs = new Map<string, DiffResult>();

  setStatus(cwd: string, records: DiffRecord[]): void {
    this.statuses.set(cwd, records);
  }

  setDiff(cwd: string, optsKey: string, result: DiffResult): void {
    this.diffs.set(`${cwd}:${optsKey}`, result);
  }

  async status(cwd: string): Promise<DiffRecord[]> {
    return this.statuses.get(cwd) ?? [];
  }

  async diff(cwd: string, opts?: { ref?: string; statOnly?: boolean }): Promise<DiffResult> {
    const key = `${cwd}:${opts?.ref ?? "worktree"}:${opts?.statOnly ?? false}`;
    return this.diffs.get(key) ?? { empty: true, stat: [], diff: "" };
  }
}
