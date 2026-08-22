import { BrowserSessionRecord } from "./schemas.js";
import type { BrowserBackendKind } from "./schemas.js";

export interface SessionManagerOptions {
  inactivityTimeoutMs?: number;
}

/**
 * In-memory per-task browser session manager.
 */
export class BrowserSessionManager {
  private sessions = new Map<string, BrowserSessionRecord>();
  private lastActivity = new Map<string, number>();

  constructor(private readonly options: SessionManagerOptions = {}) {}

  get(taskId: string): BrowserSessionRecord | undefined {
    return this.sessions.get(taskId);
  }

  set(record: BrowserSessionRecord): BrowserSessionRecord {
    const updated = BrowserSessionRecord.parse(record);
    if (record.lastActiveAt === undefined) {
      updated.lastActiveAt = Date.now();
    }
    this.sessions.set(updated.taskId, updated);
    this.lastActivity.set(updated.taskId, updated.lastActiveAt);
    return updated;
  }

  touch(taskId: string): void {
    const now = Date.now();
    const session = this.sessions.get(taskId);
    if (session) {
      session.lastActiveAt = now;
      this.lastActivity.set(taskId, now);
    }
  }

  remove(taskId: string): BrowserSessionRecord | undefined {
    this.lastActivity.delete(taskId);
    const removed = this.sessions.get(taskId);
    this.sessions.delete(taskId);
    return removed;
  }

  list(): BrowserSessionRecord[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Return task ids whose last activity is older than the configured timeout.
   */
  expired(now = Date.now()): string[] {
    const timeout = this.options.inactivityTimeoutMs ?? 0;
    if (timeout <= 0) return [];
    const expired: string[] = [];
    for (const [taskId, lastAt] of this.lastActivity.entries()) {
      if (now - lastAt > timeout) expired.push(taskId);
    }
    return expired;
  }

  clear(): BrowserSessionRecord[] {
    const all = this.list();
    this.sessions.clear();
    this.lastActivity.clear();
    return all;
  }
}

export const browserSessionManager = new BrowserSessionManager({ inactivityTimeoutMs: 300_000 });
