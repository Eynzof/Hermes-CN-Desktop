/**
 * Lightweight checkpoint/snapshot records stored as session metadata.
 *
 * Unlike the Python shadow-git store, this in-process implementation keeps
 * per-session checkpoints in the session's metadata bag and delegates git
 * read-only capture to the Rust backend. It satisfies the desktop slash
 * surface (/rollback, /snapshot, /diff) without writing to the user's repo.
 */

/** Per-file diff statistics produced by `git diff --numstat`. */
export interface DiffRecord {
  /** Repository-relative path (or the new name for a rename). */
  path: string;
  /** Lines added; `-` from git is normalised to 0 for binary files. */
  added: number;
  /** Lines removed; `-` from git is normalised to 0 for binary files. */
  removed: number;
  /** Single-letter git status: M/A/D/R/C/?. */
  status: string;
}

/** A captured filesystem + session checkpoint. */
export interface Checkpoint {
  /** Stable checkpoint id (UUID). */
  id: string;
  /** Owning session id. */
  sessionId: string;
  /** Unix ms when the checkpoint was taken. */
  timestamp: number;
  /** Human-readable reason (e.g. "before write_file"). */
  reason: string;
  /** Working directory that was snapshotted. */
  cwd: string;
  /** Optional message id that serves as the conversation baseline. */
  baselineMessageId?: number | string;
  /** Diff summary captured at creation time. */
  diffSummary?: DiffRecord[];
  /** Short git ref/state captured at creation time (read-only). */
  gitRef?: string;
}

/** A named snapshot marker, distinct from an automatic checkpoint. */
export interface Snapshot {
  /** Snapshot id (UUID). */
  id: string;
  /** Owning session id. */
  sessionId: string;
  /** Unix ms when the snapshot was created. */
  timestamp: number;
  /** User-supplied label. */
  label: string;
  /** Working directory captured. */
  cwd: string;
}

/** Result returned by diff operations. */
export interface DiffResult {
  /** True when no changes were detected. */
  empty: boolean;
  /** Per-file stat rows. */
  stat: DiffRecord[];
  /** Raw unified diff text (may be empty when only stats were requested). */
  diff: string;
  /** Optional baseline id or ref the diff is relative to. */
  baseline?: string;
}

/** Result returned by a rollback operation. */
export interface RollbackResult {
  /** Rolled-back checkpoint id. */
  checkpointId: string;
  /** Number of messages soft-deleted from the session. */
  deletedMessages: number;
  /** Whether working-directory state was restored from git. */
  restoredGit: boolean;
  /** Human-readable summary. */
  summary: string;
}
