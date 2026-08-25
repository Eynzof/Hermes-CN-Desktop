/**
 * Kanban dispatcher with worker lanes, claim TTL, crash reclaim, and a
 * per-worker circuit breaker.
 *
 * Mirrors the Python dispatcher behaviour (`hermescli/kanban_swarm.py` +
 * `hermescli/kanban.py`):
 * - workers claim tasks from their configured lane (or any lane when unset);
 * - claims expire after `claimTtlMs` and are reclaimed by `reap()`;
 * - a worker that fails `circuitBreakerThreshold` times is tripped for
 *   `circuitBreakerCooldownMs` and stops receiving claims;
 * - `heartbeat()` extends a worker's live claims so long-running work is not
 *   wrongly reclaimed.
 */

import { KanbanStore } from "./store.js";
import type { KanbanTask } from "./types.js";

export interface KanbanClaim {
  taskId: string;
  workerId: string;
  claimedAt: number;
  expiresAt: number;
}

export interface KanbanDispatcherOptions {
  store: KanbanStore;
  /** Claim lifetime before `reap()` releases it. Default 120s. */
  claimTtlMs?: number;
  /** Failures before the worker's circuit breaker trips. Default 3. */
  circuitBreakerThreshold?: number;
  /** Cooldown after tripping before the worker is usable again. Default 60s. */
  circuitBreakerCooldownMs?: number;
  /** Optional lane restriction per worker id. */
  laneForWorker?: (workerId: string) => string | undefined;
  /** Clock override for tests. */
  now?: () => number;
}

export interface WorkerStatus {
  tripped: boolean;
  failures: number;
  activeClaims: string[];
  trippedUntil?: number;
}

export class KanbanDispatcher {
  private readonly store: KanbanStore;
  private readonly claimTtlMs: number;
  private readonly circuitBreakerThreshold: number;
  private readonly circuitBreakerCooldownMs: number;
  private readonly laneForWorker: (workerId: string) => string | undefined;
  private readonly now: () => number;

  private claims = new Map<string, KanbanClaim>();
  private failures = new Map<string, number>();
  private trippedUntil = new Map<string, number>();

  constructor(options: KanbanDispatcherOptions) {
    this.store = options.store;
    this.claimTtlMs = options.claimTtlMs ?? 120_000;
    this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? 3;
    this.circuitBreakerCooldownMs = options.circuitBreakerCooldownMs ?? 60_000;
    this.laneForWorker = options.laneForWorker ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  private workerTripped(workerId: string, at = this.now()): boolean {
    const until = this.trippedUntil.get(workerId);
    return until !== undefined && until > at;
  }

  /** Reclaim expired claims; returns reclaimed task ids. */
  reap(at = this.now()): string[] {
    const reclaimed: string[] = [];
    for (const [taskId, claim] of this.claims) {
      if (claim.expiresAt <= at) {
        this.claims.delete(taskId);
        reclaimed.push(taskId);
      }
    }
    return reclaimed;
  }

  /** Extend all live claims held by a worker (heartbeat). */
  heartbeat(workerId: string, at = this.now()): number {
    let extended = 0;
    for (const [taskId, claim] of this.claims) {
      if (claim.workerId === workerId && claim.expiresAt > at) {
        claim.expiresAt = at + this.claimTtlMs;
        extended += 1;
      }
    }
    return extended;
  }

  /**
   * Claim the oldest available task for a worker, or undefined when nothing is
   * claimable (including when the worker's circuit breaker is tripped).
   *
   * A task is available when it is not currently claimed and either has no
   * assignee or is assigned to this worker. When `laneForWorker` returns a
   * lane, only tasks in that lane are considered.
   */
  claimNext(workerId: string, at = this.now()): KanbanTask | undefined {
    if (this.workerTripped(workerId, at)) return undefined;
    this.reap(at);
    const laneId = this.laneForWorker(workerId);
    const claimed = new Set(this.claims.keys());

    for (const board of this.store.list()) {
      for (const lane of board.lanes) {
        if (lane.id === "done") continue; // terminal lane: never re-claimed
        if (laneId !== undefined && lane.id !== laneId) continue;
        const task = lane.tasks.find(
          (t) => !claimed.has(t.id) && (t.assignee === undefined || t.assignee === workerId),
        );
        if (task) {
          this.claims.set(task.id, {
            taskId: task.id,
            workerId,
            claimedAt: at,
            expiresAt: at + this.claimTtlMs,
          });
          return task;
        }
      }
    }
    return undefined;
  }

  /** Mark a task complete: move to the "done" lane and release the claim. */
  complete(taskId: string, workerId: string, doneLaneId = "done"): boolean {
    const claim = this.claims.get(taskId);
    if (!claim || claim.workerId !== workerId) return false;
    this.claims.delete(taskId);
    this.failures.set(workerId, 0);
    for (const board of this.store.list()) {
      if (this.store.moveTask(board.id, taskId, doneLaneId)) return true;
    }
    return false;
  }

  /**
   * Mark a task failed: release the claim, move the task back to the first
   * lane ("todo" when present), and count a failure against the worker —
   * tripping the circuit breaker when the threshold is reached.
   */
  fail(taskId: string, workerId: string, _reason?: string, at = this.now()): void {
    const claim = this.claims.get(taskId);
    if (!claim || claim.workerId !== workerId) return;
    this.claims.delete(taskId);
    for (const board of this.store.list()) {
      const todo = board.lanes[0];
      if (todo) this.store.moveTask(board.id, taskId, todo.id);
      break;
    }
    const failures = (this.failures.get(workerId) ?? 0) + 1;
    this.failures.set(workerId, failures);
    if (failures >= this.circuitBreakerThreshold) {
      this.trippedUntil.set(workerId, at + this.circuitBreakerCooldownMs);
    }
  }

  /** Reset a worker's failure count and trip state. */
  reset(workerId: string): void {
    this.failures.delete(workerId);
    this.trippedUntil.delete(workerId);
  }

  workerStatus(workerId: string, at = this.now()): WorkerStatus {
    const activeClaims = [...this.claims.values()]
      .filter((c) => c.workerId === workerId && c.expiresAt > at)
      .map((c) => c.taskId);
    const until = this.trippedUntil.get(workerId);
    return {
      tripped: until !== undefined && until > at,
      failures: this.failures.get(workerId) ?? 0,
      activeClaims,
      trippedUntil: until !== undefined && until > at ? until : undefined,
    };
  }
}
