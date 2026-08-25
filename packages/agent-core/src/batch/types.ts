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

/** Serializable checkpoint for pause/resume (P1-23). */
export interface BatchCheckpoint {
  jobId: string;
  remainingItems: BatchItem[];
  results: BatchResult[];
  concurrency: number;
  progress: number;
  /** Inputs already completed successfully (content-based resume). */
  completedInputs: string[];
}
