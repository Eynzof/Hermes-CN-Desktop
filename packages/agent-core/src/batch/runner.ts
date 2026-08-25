import type { BatchCheckpoint, BatchItem, BatchJob, BatchItemStatus, BatchResult } from "./types.js";

export type BatchHandler = (input: string) => Promise<{ status: BatchItemStatus; output: string }>;

export interface BatchRunnerOptions {
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  /**
   * Content-based resume: when true, items whose `input` is listed in
   * `resume.completedInputs` are skipped on the next run.
   */
  skipCompleted?: boolean;
  /** Resume from a previous checkpoint (remaining items + prior results). */
  resume?: Pick<BatchCheckpoint, "jobId" | "remainingItems" | "results" | "concurrency" | "progress" | "completedInputs">;
}

export class BatchRunner {
  private job: BatchJob;
  private handler: BatchHandler;
  private onProgress?: (done: number, total: number) => void;
  private completedInputs = new Set<string>();

  constructor(items: BatchItem[], handler: BatchHandler, options: BatchRunnerOptions = {}) {
    this.handler = handler;
    this.onProgress = options.onProgress;
    const priorResults = options.resume?.results ?? [];
    const priorConcurrency = options.resume?.concurrency ?? options.concurrency ?? 4;
    const seedItems = options.resume?.remainingItems ?? items;
    const completedInputs = new Set(options.resume?.completedInputs ?? []);
    this.completedInputs = new Set(completedInputs);
    const effectiveItems =
      options.skipCompleted && completedInputs.size > 0
        ? seedItems.filter((item) => !completedInputs.has(item.input))
        : seedItems;
    this.job = {
      id: options.resume?.jobId ?? `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      items: effectiveItems,
      concurrency: priorConcurrency,
      createdAt: Date.now(),
      status: "pending",
      progress: options.resume?.progress ?? 0,
      results: priorResults,
    };
  }

  get id(): string {
    return this.job.id;
  }

  snapshot(): BatchJob {
    return { ...this.job, items: this.job.items.slice(), results: this.job.results.slice() };
  }

  /** Serializable checkpoint for pause/resume (P1-23). */
  checkpoint(): BatchCheckpoint {
    return {
      jobId: this.job.id,
      remainingItems: this.job.items.slice(),
      results: this.job.results.slice(),
      concurrency: this.job.concurrency,
      progress: this.job.progress,
      completedInputs: [...this.completedInputs],
    };
  }

  async run(): Promise<BatchJob> {
    this.job.status = "running";
    const total = this.job.items.length;
    let done = 0;
    const runOne = async (item: BatchItem): Promise<BatchResult> => {
      try {
        const out = await this.handler(item.input);
        if (out.status === "success") this.completedInputs.add(item.input);
        return { itemId: item.id, status: out.status, output: out.output };
      } catch (err) {
        return {
          itemId: item.id,
          status: "error",
          output: err instanceof Error ? err.message : String(err),
        };
      }
    };
    const worker = async (): Promise<void> => {
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
