/**
 * Subagent stall monitor.
 *
 * Tracks progress heartbeats per task; a task whose last heartbeat is older
 * than the threshold is reported as stalled. Mirrors the Python stall monitor
 * used by async delegation so hung agents are surfaced to the UI/runtime.
 */

export interface StallMonitorOptions {
  /** No heartbeat for this many ms ⇒ stalled. Default 60s. */
  thresholdMs?: number;
  now?: () => number;
}

export class StallMonitor {
  private readonly thresholdMs: number;
  private readonly now: () => number;
  private lastHeartbeat = new Map<string, number>();

  constructor(options: StallMonitorOptions = {}) {
    this.thresholdMs = options.thresholdMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Register a task and record its first heartbeat. */
  track(taskId: string): void {
    this.lastHeartbeat.set(taskId, this.now());
  }

  /** Record progress for a task. */
  heartbeat(taskId: string): void {
    this.lastHeartbeat.set(taskId, this.now());
  }

  /** True when the task is tracked and has not heartbeated recently. */
  isStalled(taskId: string): boolean {
    const last = this.lastHeartbeat.get(taskId);
    if (last === undefined) return false;
    return this.now() - last > this.thresholdMs;
  }

  /** Ids of every tracked task currently stalled. */
  stalledTaskIds(): string[] {
    return [...this.lastHeartbeat.keys()].filter((id) => this.isStalled(id));
  }

  /** Stop tracking a task (completed/aborted). */
  untrack(taskId: string): void {
    this.lastHeartbeat.delete(taskId);
  }
}
