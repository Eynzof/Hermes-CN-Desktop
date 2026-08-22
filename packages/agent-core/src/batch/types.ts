export interface BatchItem {
  id: string;
  input: string;
}

export type BatchItemStatus = "pending" | "running" | "success" | "error";

export interface BatchResult {
  itemId: string;
  status: BatchItemStatus;
  output: string;
}

export interface BatchJob {
  id: string;
  items: BatchItem[];
  concurrency: number;
  createdAt: number;
  status: "pending" | "running" | "done";
  progress: number;
  results: BatchResult[];
}
