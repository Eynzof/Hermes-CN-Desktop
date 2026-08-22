import type { SessionStore } from "../session/store.js";
import type { GitDiffProvider } from "./git-diff.js";
import type { Checkpoint, DiffRecord, DiffResult, RollbackResult, Snapshot } from "./types.js";

export type { Checkpoint, DiffRecord, DiffResult, RollbackResult, Snapshot };

const METADATA_KEY = "_hermes_checkpoints_v1";

interface PersistedMetadata {
  checkpoints: Checkpoint[];
  snapshots: Snapshot[];
}

/**
 * Minimal dependencies required by `CheckpointStore`.
 *
 * A desktop/web session store can implement this directly, or an agent-core
 * `SessionStore` can be wrapped via {@link checkpointStoreDepsFromSessionStore}.
 */
export interface CheckpointStoreDeps {
  /** Resolve the working directory for a session, if known. */
  getSessionCwd(sessionId: string): Promise<string | undefined>;
  /** Read a metadata key for a session. */
  getSessionMetadata(sessionId: string, key: string): Promise<unknown | undefined>;
  /** Write a metadata key for a session. */
  setSessionMetadata(sessionId: string, key: string, value: unknown): Promise<void>;
}

export interface CheckpointStoreOptions {
  /** Dependencies for session metadata and cwd resolution. */
  deps: CheckpointStoreDeps;
  /** Optional git capture provider; defaults to a no-op provider. */
  gitDiff?: GitDiffProvider;
  /**
   * Optional callback that rewinds session messages to a baseline message id.
   * Should return the number of messages removed/deactivated.
   */
  rewindMessages?: (sessionId: string, baselineMessageId: number | string) => Promise<number>;
}

/**
 * Wrap an agent-core `SessionStore` into {@link CheckpointStoreDeps}.
 */
export function checkpointStoreDepsFromSessionStore(sessionStore: SessionStore): CheckpointStoreDeps {
  return {
    async getSessionCwd(sessionId: string) {
      const session = await sessionStore.getSession(sessionId);
      return session?.cwd;
    },
    async getSessionMetadata(sessionId: string, key: string) {
      if (sessionStore.getSessionMetadata) {
        return sessionStore.getSessionMetadata(sessionId, key);
      }
      return undefined;
    },
    async setSessionMetadata(sessionId: string, key: string, value: unknown) {
      if (sessionStore.setSessionMetadata) {
        await sessionStore.setSessionMetadata(sessionId, key, value);
      }
    },
  };
}

export interface CreateCheckpointOptions {
  sessionId: string;
  reason: string;
  cwd: string;
  /** Message id that will be used as the rollback baseline. */
  baselineMessageId?: number | string;
  /** If false, skip the git diff capture. */
  captureDiff?: boolean;
}

export interface CreateSnapshotOptions {
  sessionId: string;
  label: string;
  cwd: string;
}

export interface RollbackOptions {
  /** If true, also restore git working-tree state via the git provider. */
  restoreGit?: boolean;
  /** If true, also rewind session messages to the checkpoint baseline. */
  rewindMessages?: boolean;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for test/node environments without global crypto.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowMs(): number {
  return Date.now();
}

/**
 * In-process checkpoint/snapshot manager.
 *
 * Checkpoints are persisted in the session metadata bag when the underlying
 * `SessionStore` exposes `getSessionMetadata`/`setSessionMetadata`; otherwise
 * they are kept in memory keyed by session id. The manager never mutates git
 * state directly — git capture/restore is delegated to the injected provider.
 */
export class CheckpointStore {
  private readonly deps: CheckpointStoreDeps;
  private readonly gitDiff: GitDiffProvider;
  private readonly rewindMessages?: (sessionId: string, baselineMessageId: number | string) => Promise<number>;
  /** Fallback in-memory metadata when the session store lacks metadata helpers. */
  private readonly fallback = new Map<string, PersistedMetadata>();

  constructor(options: CheckpointStoreOptions) {
    this.deps = options.deps;
    this.gitDiff = options.gitDiff ?? {
      async status() {
        return [];
      },
      async diff() {
        return { empty: true, stat: [], diff: "" };
      },
    };
    this.rewindMessages = options.rewindMessages;
  }

  /** Create a checkpoint from the current session and git state. */
  async createCheckpoint(options: CreateCheckpointOptions): Promise<Checkpoint> {
    const captureDiff = options.captureDiff ?? true;
    const diffResult = captureDiff ? await this.captureDiff(options.cwd) : { empty: true, stat: [], diff: "" };
    const checkpoint: Checkpoint = {
      id: randomId(),
      sessionId: options.sessionId,
      timestamp: nowMs(),
      reason: options.reason,
      cwd: options.cwd,
      baselineMessageId: options.baselineMessageId,
      diffSummary: diffResult.stat,
    };

    const meta = await this.loadMetadata(options.sessionId);
    meta.checkpoints.push(checkpoint);
    await this.saveMetadata(options.sessionId, meta);
    return checkpoint;
  }

  /** List checkpoints for a session, newest first. */
  async listCheckpoints(sessionId: string): Promise<Checkpoint[]> {
    const meta = await this.loadMetadata(sessionId);
    return [...meta.checkpoints]
      .map((c, idx) => ({ c, idx }))
      .sort((a, b) => {
        if (b.c.timestamp !== a.c.timestamp) return b.c.timestamp - a.c.timestamp;
        return b.idx - a.idx;
      })
      .map(({ c }) => c);
  }

  /** Get a single checkpoint by id. */
  async getCheckpoint(sessionId: string, checkpointId: string): Promise<Checkpoint | undefined> {
    const checkpoints = await this.listCheckpoints(sessionId);
    return checkpoints.find((c) => c.id === checkpointId);
  }

  /** Create a named snapshot marker for the session. */
  async createSnapshot(options: CreateSnapshotOptions): Promise<Snapshot> {
    const snapshot: Snapshot = {
      id: randomId(),
      sessionId: options.sessionId,
      timestamp: nowMs(),
      label: options.label || "snapshot",
      cwd: options.cwd,
    };
    const meta = await this.loadMetadata(options.sessionId);
    meta.snapshots.push(snapshot);
    await this.saveMetadata(options.sessionId, meta);
    return snapshot;
  }

  /** List snapshots for a session, newest first. */
  async listSnapshots(sessionId: string): Promise<Snapshot[]> {
    const meta = await this.loadMetadata(sessionId);
    return [...meta.snapshots]
      .map((s, idx) => ({ s, idx }))
      .sort((a, b) => {
        if (b.s.timestamp !== a.s.timestamp) return b.s.timestamp - a.s.timestamp;
        return b.idx - a.idx;
      })
      .map(({ s }) => s);
  }

  /**
   * Diff the working directory or a captured checkpoint.
   *
   * If `checkpointId` is omitted, captures the current uncommitted diff.
   * If provided, returns the stat captured at checkpoint time (cheap replay).
   */
  async diff(sessionId: string, checkpointId?: string): Promise<DiffResult> {
    if (!checkpointId) {
      // Session-level diff: capture current cwd. Use the session cwd if known.
      const cwd = await this.deps.getSessionCwd(sessionId);
      return this.captureDiff(cwd ?? ".");
    }

    const checkpoint = await this.getCheckpoint(sessionId, checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }
    return {
      empty: !checkpoint.diffSummary || checkpoint.diffSummary.length === 0,
      stat: checkpoint.diffSummary ?? [],
      diff: "",
      baseline: checkpoint.baselineMessageId ? String(checkpoint.baselineMessageId) : undefined,
    };
  }

  /**
   * Roll back to a checkpoint.
   *
   * By default this rewinds session messages to the checkpoint baseline and,
   * when a git restore provider is present and `restoreGit` is true, restores
   * the working tree. It never silently mutates git state.
   */
  async rollback(sessionId: string, checkpointId: string, options: RollbackOptions = {}): Promise<RollbackResult> {
    const checkpoint = await this.getCheckpoint(sessionId, checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    const shouldRewind = options.rewindMessages ?? true;
    const shouldRestoreGit = options.restoreGit ?? false;

    let deletedMessages = 0;
    if (shouldRewind && checkpoint.baselineMessageId !== undefined) {
      if (!this.rewindMessages) {
        throw new Error("rewindMessages callback is required to roll back session messages");
      }
      deletedMessages = await this.rewindMessages(sessionId, checkpoint.baselineMessageId);
    }

    let restoredGit = false;
    let restoreMessage: string | undefined;
    if (shouldRestoreGit && checkpoint.gitRef && this.gitDiff.restore) {
      const restoreResult = await this.gitDiff.restore(checkpoint.cwd, checkpoint.gitRef);
      restoredGit = restoreResult.restored;
      restoreMessage = restoreResult.message;
    }

    const summary = restoreMessage
      ? `Rolled back to checkpoint ${checkpointId} (${deletedMessages} messages removed; ${restoredGit ? "git restored" : "git unchanged"}).`
      : `Rolled back to checkpoint ${checkpointId} (${deletedMessages} messages removed).`;

    return {
      checkpointId,
      deletedMessages,
      restoredGit,
      summary,
    };
  }

  /** Drop a single checkpoint from the session metadata. */
  async deleteCheckpoint(sessionId: string, checkpointId: string): Promise<boolean> {
    const meta = await this.loadMetadata(sessionId);
    const before = meta.checkpoints.length;
    meta.checkpoints = meta.checkpoints.filter((c) => c.id !== checkpointId);
    await this.saveMetadata(sessionId, meta);
    return meta.checkpoints.length < before;
  }

  private async captureDiff(cwd: string): Promise<DiffResult> {
    const stat = await this.gitDiff.status(cwd);
    const diff = await this.gitDiff.diff(cwd, { statOnly: true });
    return {
      empty: stat.length === 0,
      stat,
      diff: diff.diff,
    };
  }

  private async loadMetadata(sessionId: string): Promise<PersistedMetadata> {
    const raw = await this.deps.getSessionMetadata(sessionId, METADATA_KEY);
    if (raw && typeof raw === "object") {
      const parsed = raw as Partial<PersistedMetadata>;
      return {
        checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
        snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
      };
    }
    return this.fallback.get(sessionId) ?? { checkpoints: [], snapshots: [] };
  }

  private async saveMetadata(sessionId: string, meta: PersistedMetadata): Promise<void> {
    await this.deps.setSessionMetadata(sessionId, METADATA_KEY, meta);
  }
}
