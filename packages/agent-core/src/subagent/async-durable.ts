/**
 * Async durable subagent background execution.
 *
 * Submits tasks that run in the background and can be resolved later by task
 * id — including across a process restart when a `storage` adapter is
 * provided. Mirrors Python `tools/asyncdelegation.py` (durable background
 * delegation with a persistent ledger).
 */

export type DurableTaskStatus = "queued" | "running" | "done" | "failed";

export interface DurableTask<T = unknown> {
  id: string;
  status: DurableTaskStatus;
  input: unknown;
  result?: T;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DurableStorage {
  get(id: string): Promise<DurableTask | undefined>;
  set(task: DurableTask): Promise<void>;
  list?(): Promise<DurableTask[]>;
}

export interface AsyncDurableRunnerOptions<T = unknown> {
  executor: (input: unknown) => Promise<T>;
  storage?: DurableStorage;
  now?: () => number;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `durable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class AsyncDurableRunner<T = unknown> {
  private readonly executor: (input: unknown) => Promise<T>;
  private readonly storage?: DurableStorage;
  private readonly now: () => number;
  private memory = new Map<string, DurableTask<T>>();

  constructor(options: AsyncDurableRunnerOptions<T>) {
    this.executor = options.executor;
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
  }

  /** Submit a background task; execution starts immediately. */
  submit(input: unknown): DurableTask<T> {
    const task: DurableTask<T> = {
      id: randomId(),
      status: "queued",
      input,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.memory.set(task.id, task);
    void this.persist(task);
    // Defer execution so `submit` returns the queued task before work starts.
    queueMicrotask(() => {
      void this.execute(task.id);
    });
    return task;
  }

  async get(id: string): Promise<DurableTask<T> | undefined> {
    return this.memory.get(id) ?? (await this.storage?.get(id)) as DurableTask<T> | undefined;
  }

  async list(): Promise<DurableTask<T>[]> {
    const mem = [...this.memory.values()];
    if (this.storage?.list) {
      const stored = await this.storage.list();
      const storedIds = new Set(stored.map((s) => s.id));
      const restored = stored.filter((s) => !this.memory.has(s.id));
      return [...mem, ...(restored as DurableTask<T>[])];
    }
    return mem;
  }

  /** Wait for a task to reach a terminal status (done/failed). */
  async waitFor(id: string, timeoutMs = 30_000): Promise<DurableTask<T>> {
    const started = this.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const task = await this.get(id);
      if (task && (task.status === "done" || task.status === "failed")) return task;
      if (this.now() - started > timeoutMs) {
        throw new Error(`durable task ${id} did not finish within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async execute(id: string): Promise<void> {
    const task = this.memory.get(id);
    if (!task) return;
    task.status = "running";
    task.updatedAt = this.now();
    await this.persist(task);
    try {
      const result = await this.executor(task.input);
      task.status = "done";
      task.result = result;
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
    }
    task.updatedAt = this.now();
    await this.persist(task);
  }

  private async persist(task: DurableTask<T>): Promise<void> {
    if (this.storage) {
      try {
        await this.storage.set(task as DurableTask);
      } catch {
        // Persistence is best-effort; the in-memory copy remains authoritative.
      }
    }
  }
}
