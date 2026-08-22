export interface CuratorSnapshot {
  id: string;
  sessionId: string;
  capturedAt: number;
  summary: string;
  artifactPaths: string[];
}

export interface CuratorRun {
  id: string;
  startedAt: number;
  status: "running" | "done" | "error";
  snapshots: CuratorSnapshot[];
  report: string;
}
