// Worktree / branch / status state for the projects sidebar (issue #327). Wraps
// the Rust git commands (which shell `git`) into a small hook: load a repo's
// worktrees, branches, and compact status, and drive create / remove / switch /
// checkout mutations that re-sync afterward. Sequence-guarded so a slow load that
// lands after the repo changed is dropped.

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitBranch, RepoStatus, Worktree } from "@/lib/runtime";

export interface UseWorktrees {
  worktrees: Worktree[];
  branches: GitBranch[];
  status: RepoStatus | null;
  loading: boolean;
  isRepo: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => void;
  /** Create a new branch + worktree (`hermes/<slug-of-name>`). */
  addWorktree: (name: string, base?: string | null) => Promise<boolean>;
  /** Check an existing branch out into a worktree (or switch in place if it's the trunk). */
  checkoutBranch: (branch: string) => Promise<boolean>;
  removeWorktree: (path: string, force?: boolean) => Promise<boolean>;
  switchBranch: (branch: string) => Promise<boolean>;
  dismissError: () => void;
}

export function useWorktrees(repoPath: string): UseWorktrees {
  const cwd = repoPath?.trim() ?? "";
  const bridge = typeof window !== "undefined" ? window.hermesDesktop?.git : undefined;

  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [isRepo, setIsRepo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const id = (seq.current += 1);
    if (!cwd || !bridge) {
      setWorktrees([]);
      setBranches([]);
      setStatus(null);
      setIsRepo(false);
      return;
    }
    setLoading(true);
    try {
      const [wt, br, st] = await Promise.all([
        bridge.worktree.list({ repoPath: cwd }),
        bridge.branch.list({ repoPath: cwd }),
        bridge.repoStatus({ repoPath: cwd }),
      ]);
      if (id !== seq.current) return;
      setWorktrees(wt);
      setBranches(br);
      setStatus(st);
      setIsRepo(st !== null || wt.length > 0);
    } catch {
      if (id === seq.current) {
        setWorktrees([]);
        setBranches([]);
        setStatus(null);
        setIsRepo(false);
      }
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [cwd, bridge]);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
      if (!bridge || !cwd) return false;
      setError(null);
      setBusy(true);
      try {
        await fn();
        await refresh();
        return true;
      } catch (err) {
        setError(`${label}失败：${err instanceof Error ? err.message : String(err)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [bridge, cwd, refresh],
  );

  const addWorktree = useCallback(
    (name: string, base?: string | null) =>
      run("新建工作树", () =>
        bridge!.worktree.add({ repoPath: cwd, name, base: base ?? null }),
      ),
    [run, bridge, cwd],
  );

  const checkoutBranch = useCallback(
    (branch: string) =>
      run("检出分支", () => bridge!.worktree.add({ repoPath: cwd, existingBranch: branch })),
    [run, bridge, cwd],
  );

  const removeWorktree = useCallback(
    (path: string, force?: boolean) =>
      run("删除工作树", () =>
        bridge!.worktree.remove({ repoPath: cwd, worktreePath: path, force: force ?? false }),
      ),
    [run, bridge, cwd],
  );

  const switchBranch = useCallback(
    (branch: string) => run("切换分支", () => bridge!.branch.switch({ repoPath: cwd, branch })),
    [run, bridge, cwd],
  );

  const dismissError = useCallback(() => setError(null), []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    worktrees,
    branches,
    status,
    loading,
    isRepo,
    busy,
    error,
    refresh: () => void refresh(),
    addWorktree,
    checkoutBranch,
    removeWorktree,
    switchBranch,
    dismissError,
  };
}
