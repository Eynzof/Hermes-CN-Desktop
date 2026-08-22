import {
  CheckpointStore,
  checkpointStoreDepsFromSessionStore,
  type CheckpointStoreDeps,
  type DiffRecord,
  type GitDiffProvider,
  type Snapshot,
} from "@hermes/agent-core";
import type { SessionStore } from "@/lib/session-store/session-store";
import type { CommandResult } from "../types";

export interface CheckpointsHandlerContext {
  activeSessionId: string | null;
  store: SessionStore;
  checkpointStore: CheckpointStore;
  cwd?: string | null;
  notify?: (message: string) => void;
}

/**
 * Build desktop/web {@link CheckpointStoreDeps} from the web {@link SessionStore}.
 */
export function webCheckpointStoreDeps(
  store: SessionStore,
): CheckpointStoreDeps {
  return {
    getSessionCwd: async (sessionId) => (await store.get(sessionId))?.cwd ?? undefined,
    getSessionMetadata: (sessionId, key) => store.getSessionMetadata(sessionId, key),
    setSessionMetadata: (sessionId, key, value) => store.setSessionMetadata(sessionId, key, value),
  };
}

/**
 * Build a `GitDiffProvider` backed by the Rust Tauri checkpoint commands.
 * Falls back to empty results when the bridge is unavailable.
 */
export function createTauriGitDiffProvider(): GitDiffProvider {
  const bridge = typeof window !== "undefined" ? window.hermesDesktop?.checkpoints : undefined;
  return {
    async status(cwd: string) {
      if (!bridge) return [];
      const result = await bridge.status({ cwd });
      return result.files.map((f) => ({
        path: f.path,
        added: 0,
        removed: 0,
        status: f.status,
      }));
    },
    async diff(cwd: string, opts?: { ref?: string; statOnly?: boolean }) {
      if (!bridge) return { empty: true, stat: [], diff: "" };
      const result = await bridge.diff({
        cwd,
        baseRef: opts?.ref ?? null,
        statOnly: opts?.statOnly ?? true,
      });
      return {
        empty: result.empty,
        stat: result.stat.map((s) => ({
          path: s.path,
          added: s.added,
          removed: s.removed,
          status: s.status,
        })),
        diff: result.diff,
      };
    },
  };
}

/**
 * Create a {@link CheckpointStore} wired to the web session store and Rust git
 * capture commands.
 */
export function createWebCheckpointStore(
  store: SessionStore,
  opts?: {
    gitDiff?: GitDiffProvider;
    rewindMessages?: (sessionId: string, baselineMessageId: number | string) => Promise<number>;
  },
): CheckpointStore {
  return new CheckpointStore({
    deps: webCheckpointStoreDeps(store),
    gitDiff: opts?.gitDiff ?? createTauriGitDiffProvider(),
    rewindMessages: opts?.rewindMessages,
  });
}

function err(message: string): CommandResult {
  return { type: "error", message };
}

function ok(output: string, extras?: Partial<CommandResult>): CommandResult {
  return { type: "exec", output, ...extras };
}

function formatDiffStat(stat: DiffRecord[]): string {
  if (stat.length === 0) return "No changes.";
  const lines = stat.map((row) => {
    const added = row.added > 0 ? `+${row.added}` : row.added === 0 ? "0" : "-";
    const removed = row.removed > 0 ? `-${row.removed}` : row.removed === 0 ? "0" : "-";
    return `${row.status.padEnd(1)} ${added.padStart(6)} ${removed.padStart(6)} ${row.path}`;
  });
  return lines.join("\n");
}

function formatSnapshots(snapshots: Snapshot[]): string {
  if (snapshots.length === 0) return "No snapshots.";
  return snapshots
    .map((s) => {
      const date = new Date(s.timestamp).toLocaleString();
      return `- ${s.id.slice(0, 8)} @ ${date}: ${s.label}`;
    })
    .join("\n");
}

/**
 * `/rollback [checkpointId]` — list checkpoints or roll back to a checkpoint.
 */
export async function handleRollback(args: string, ctx: CheckpointsHandlerContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) {
    return err("No active session");
  }

  const id = args.trim();
  const checkpoints = await ctx.checkpointStore.listCheckpoints(ctx.activeSessionId);

  if (!id) {
    if (checkpoints.length === 0) {
      return ok("No checkpoints for this session.");
    }
    const lines = checkpoints.map((cp) => {
      const date = new Date(cp.timestamp).toLocaleString();
      const files = cp.diffSummary?.length ?? 0;
      return `- ${cp.id.slice(0, 8)} @ ${date}: ${cp.reason} (${files} files)`;
    });
    return ok(`Checkpoints:\n${lines.join("\n")}`);
  }

  const target = checkpoints.find((cp) => cp.id === id || cp.id.startsWith(id));
  if (!target) {
    return err(`Checkpoint ${id} not found`);
  }

  const result = await ctx.checkpointStore.rollback(ctx.activeSessionId, target.id, {
    rewindMessages: true,
    restoreGit: false,
  });
  ctx.notify?.(result.summary);
  return ok(result.summary, { clearView: true });
}

/**
 * `/snapshot [label]` — create a named snapshot for the current session.
 */
export async function handleSnapshot(args: string, ctx: CheckpointsHandlerContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) {
    return err("No active session");
  }

  const label = args.trim() || "snapshot";
  const cwd = ctx.cwd ?? ".";
  const snapshot = await ctx.checkpointStore.createSnapshot({
    sessionId: ctx.activeSessionId,
    label,
    cwd,
  });
  ctx.notify?.(`Snapshot ${snapshot.id.slice(0, 8)} created`);
  return ok(`Created snapshot ${snapshot.id.slice(0, 8)}: ${label}`);
}

/**
 * `/diff [checkpointId]` — show current session diff or a captured checkpoint diff.
 */
export async function handleDiff(args: string, ctx: CheckpointsHandlerContext): Promise<CommandResult> {
  if (!ctx.activeSessionId) {
    return err("No active session");
  }

  const id = args.trim();
  const diffResult = await ctx.checkpointStore.diff(ctx.activeSessionId, id || undefined);
  const stat = formatDiffStat(diffResult.stat);
  if (id) {
    return ok(`Diff for checkpoint ${id}:\n${stat}`);
  }
  return ok(`Session diff:\n${stat}`);
}
