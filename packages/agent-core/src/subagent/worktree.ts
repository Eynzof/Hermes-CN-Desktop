/**
 * Subagent worktree isolation.
 *
 * Each delegated agent gets an isolated worktree (unique id + relative path).
 * This is a virtual model mirroring Python `tools/subagentworktree.py`: the
 * actual filesystem/worktree creation is owned by Rust or the managed runtime;
 * the TS side tracks identity and lifecycle so browser-only dev behaves the
 * same way.
 */

export interface SubagentWorktree {
  id: string;
  /** Path relative to the session workspace (e.g. `.hermes-worktrees/<id>`). */
  path: string;
  createdAt: number;
}

export interface WorktreeManagerOptions {
  now?: () => number;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `wt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class WorktreeManager {
  private worktrees = new Map<string, SubagentWorktree>();
  private readonly now: () => number;

  constructor(options: WorktreeManagerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Create an isolated worktree and return its record. */
  create(): SubagentWorktree {
    const id = randomId();
    const record: SubagentWorktree = {
      id,
      path: `.hermes-worktrees/${id}`,
      createdAt: this.now(),
    };
    this.worktrees.set(id, record);
    return record;
  }

  get(id: string): SubagentWorktree | undefined {
    return this.worktrees.get(id);
  }

  list(): SubagentWorktree[] {
    return Array.from(this.worktrees.values());
  }

  remove(id: string): boolean {
    return this.worktrees.delete(id);
  }

  /** Attach an existing worktree record (e.g. restored from durable storage). */
  attach(record: SubagentWorktree): void {
    this.worktrees.set(record.id, record);
  }
}
