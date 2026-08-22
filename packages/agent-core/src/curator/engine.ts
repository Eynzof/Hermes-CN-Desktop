import type { CuratorRun, CuratorSnapshot } from "./types.js";

export interface CuratorCollector {
  collect(sessionId: string): Promise<{ summary: string; artifactPaths: string[] }>;
}

export interface CuratorBackupBackend {
  backup(snapshot: CuratorSnapshot): Promise<{ ok: boolean; path: string }>;
}

export class CuratorEngine {
  private collector: CuratorCollector;
  private backup: CuratorBackupBackend;

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
    return snapshot;
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
