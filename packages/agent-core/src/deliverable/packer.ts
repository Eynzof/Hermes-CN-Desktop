import type { Deliverable, DeliverableArtifact, DeliverableFormat } from "./types.js";

export interface DeliverableArchiveBackend {
  pack(name: string, format: DeliverableFormat, artifacts: DeliverableArtifact[]): Promise<{
    path: string;
    sizeBytes: number;
  }>;
}

export class DeliverablePacker {
  private backend: DeliverableArchiveBackend;
  private artifacts: DeliverableArtifact[] = [];
  private name: string;
  private format: DeliverableFormat;

  constructor(name: string, format: DeliverableFormat = "folder", backend: DeliverableArchiveBackend) {
    this.name = name;
    this.format = format;
    this.backend = backend;
  }

  addFile(path: string, content?: string): void {
    this.artifacts.push({ path, name: path.split("/").pop() ?? path, content });
  }

  addFiles(paths: string[]): void {
    for (const p of paths) this.addFile(p);
  }

  async pack(): Promise<Deliverable> {
    const archive = await this.backend.pack(this.name, this.format, this.artifacts);
    return {
      id: `del-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: this.name,
      format: this.format,
      artifacts: this.artifacts.slice(),
      createdAt: Date.now(),
    };
  }
}

export function createStubArchiveBackend(): DeliverableArchiveBackend {
  return {
    async pack(name, format, artifacts) {
      return {
        path: `/tmp/${name}.${format}`,
        sizeBytes: artifacts.reduce((sum, a) => sum + (a.content?.length ?? 0), 0),
      };
    },
  };
}
