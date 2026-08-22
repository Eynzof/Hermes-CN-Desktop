export interface DeliverableArtifact {
  path: string;
  name?: string;
  mimeType?: string;
  content?: string;
}

export type DeliverableFormat = "zip" | "tar" | "folder" | "markdown";

export interface Deliverable {
  id: string;
  name: string;
  format: DeliverableFormat;
  artifacts: DeliverableArtifact[];
  createdAt: number;
}
