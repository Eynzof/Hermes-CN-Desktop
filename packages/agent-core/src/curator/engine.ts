import type { CuratorRun, CuratorSnapshot } from "./types.js";

export interface CuratorCollector {
  collect(sessionId: string): Promise<{ summary: string; artifactPaths: string[] }>;
}

export interface CuratorBackupBackend {
  backup(snapshot: CuratorSnapshot): Promise<{ ok: boolean; path: string }>;
  list?(): Promise<Array<{ snapshotId: string; path: string }>>;
  restore?(snapshotId: string): Promise<{ ok: boolean; paths: string[] }>;
}

export class CuratorEngine {
  private collector: CuratorCollector;
  private backup: CuratorBackupBackend;
  private pinned = new Set<string>();
  private snapshots = new Map<string, CuratorSnapshot>();

  constructor(collector: CuratorCollector, backup: CuratorBackupBackend) {
    this.collector = collector;
    this.backup = backup;
  }

  async snapshot(sessionId: string): Promise<CuratorSnapshot> {
    const data = await this.collector.collect(sessionId);
    const snapshot: CuratorSnapshot = {
      id: `snap-${Date.now()}`,
      sessionId,
      capturedAt: Date.now(),
      summary: data.summary,
      artifactPaths: data.artifactPaths,
    };
    await this.backup.backup(snapshot);
    this.snapshots.set(snapshot.id, snapshot);
    return snapshot;
  }

  getSnapshot(id: string): CuratorSnapshot | undefined {
    return this.snapshots.get(id);
  }

  /** Pin a snapshot so it is never pruned (P1-24). */
  pin(snapshotId: string): boolean {
    if (!this.snapshots.has(snapshotId)) return false;
    this.pinned.add(snapshotId);
    return true;
  }

  unpin(snapshotId: string): boolean {
    return this.pinned.delete(snapshotId);
  }

  isPinned(snapshotId: string): boolean {
    return this.pinned.has(snapshotId);
  }

  pinnedSnapshots(): CuratorSnapshot[] {
    return [...this.pinned]
      .map((id) => this.snapshots.get(id))
      .filter((s): s is CuratorSnapshot => s !== undefined);
  }

  /** Rollback to a snapshot: delegate artifact restore to the backup backend (P1-24). */
  async rollback(snapshotId: string): Promise<{ ok: boolean; paths: string[]; error?: string }> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) return { ok: false, paths: [], error: `unknown snapshot ${snapshotId}` };
    if (!this.backup.restore) {
      return { ok: false, paths: [], error: "backup backend does not support restore" };
    }
    return this.backup.restore(snapshotId);
  }

  /** List backups from the backend when supported (P1-24). */
  async listBackups(): Promise<Array<{ snapshotId: string; path: string }>> {
    if (!this.backup.list) return [];
    return this.backup.list();
  }

  async run(sessionId: string): Promise<CuratorRun> {
    const run: CuratorRun = {
      id: `cur-${Date.now()}`,
      startedAt: Date.now(),
      status: "running",
      snapshots: [],
      report: "",
    };
    try {
      const snap = await this.snapshot(sessionId);
      run.snapshots.push(snap);
      run.report = `Snapshot captured: ${snap.summary}`;
      run.status = "done";
    } catch (err) {
      run.status = "error";
      run.report = err instanceof Error ? err.message : String(err);
    }
    return run;
  }
}

export function createStubCollector(): CuratorCollector {
  return {
    async collect(sessionId) {
      return {
        summary: `Session ${sessionId} summary`,
        artifactPaths: ["context.md"],
      };
    },
  };
}

export function createStubBackup(): CuratorBackupBackend {
  return {
    async backup(snapshot) {
      return { ok: true, path: `/backup/${snapshot.id}` };
    },
  };
}
