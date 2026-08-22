import type { BatchItem, BatchJob, BatchItemStatus, BatchResult } from "./types.js";

export type BatchHandler = (input: string) => Promise<{ status: BatchItemStatus; output: string }>;

export interface BatchRunnerOptions {
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export class BatchRunner {
  private job: BatchJob;
  private handler: BatchHandler;
  private onProgress?: (done: number, total: number) => void;

  constructor(items: BatchItem[], handler: BatchHandler, options: BatchRunnerOptions = {}) {
    this.handler = handler;
    this.onProgress = options.onProgress;
    this.job = {
      id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      items,
      concurrency: options.concurrency ?? 4,
      createdAt: Date.now(),
      status: "pending",
      progress: 0,
      results: [],
    };
  }

  get id(): string {
    return this.job.id;
  }

  snapshot(): BatchJob {
    return { ...this.job, items: this.job.items.slice(), results: this.job.results.slice() };
  }

  async run(): Promise<BatchJob> {
    this.job.status = "running";
    const total = this.job.items.length;
    let done = 0;

    const runOne = async (item: BatchItem): Promise<BatchResult> => {
      try {
        const out = await this.handler(item.input);
        return { itemId: item.id, status: out.status, output: out.output };
      } catch (err) {
        return {
          itemId: item.id,
          status: "error",
          output: err instanceof Error ? err.message : String(err),
        };
      }
    };

    const worker = async () => {
      while (this.job.status === "running") {
        const item = this.job.items.shift();
        if (!item) return;
        const result = await runOne(item);
        this.job.results.push(result);
        done++;
        this.job.progress = Math.round((done / total) * 100);
        this.onProgress?.(done, total);
      }
    };

    const workers = Array.from({ length: this.job.concurrency }, () => worker());
    await Promise.all(workers);

    this.job.status = "done";
    return this.snapshot();
  }
}
