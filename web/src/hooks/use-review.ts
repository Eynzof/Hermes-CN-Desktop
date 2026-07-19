// Review pane state machine (issue #328). Ports the upstream `store/review.ts`
// to a self-contained hook: the active session's workspace root is the repo, and
// git is the source of truth. Scope is always "uncommitted" — Hermes' flow is
// agent edits you review BEFORE committing, so branch/last-turn are almost always
// empty here. Reads are sequence-guarded so a result that lands after the repo
// moved on is dropped; mutations re-sync the list (+ the open diff) afterward.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewFile, ReviewShipInfo } from "@/lib/runtime";

export type ReviewTreeMode = "list" | "tree";
export type CommitAction = "commit" | "commitPush";

const TREE_MODE_KEY = "hermes-cn.review.treeMode";
const COMMIT_DEFAULT_KEY = "hermes-cn.review.commitDefault";

function readStored<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = localStorage.getItem(key);
    return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persistence is best-effort; private-mode storage failures are non-fatal.
  }
}

const EMPTY_SHIP: ReviewShipInfo = { ghReady: false, pr: null };

export interface UseReview {
  files: ReviewFile[];
  loading: boolean;
  /** The desktop git bridge is available (false in pure-browser web mode). */
  hasBridge: boolean;
  /** Backend verdict: the workspace root is inside a git work tree. */
  isRepo: boolean;
  selectedPath: string | null;
  selectedFile: ReviewFile | undefined;
  diff: string | null;
  diffLoading: boolean;
  shipInfo: ReviewShipInfo;
  shipBusy: boolean;
  actionError: string | null;
  treeMode: ReviewTreeMode;
  commitDefault: CommitAction;
  refresh: () => void;
  selectFile: (file: ReviewFile) => void;
  clearSelection: () => void;
  stageAll: () => void;
  revertAll: () => void;
  stage: (path: string) => void;
  unstage: (path: string) => void;
  revert: (path: string) => void;
  commit: (message: string, push: boolean) => Promise<boolean>;
  createOrOpenPr: () => void;
  dismissError: () => void;
  setTreeMode: (mode: ReviewTreeMode) => void;
  setCommitDefault: (action: CommitAction) => void;
}

export function useReview(workspaceRoot: string, active: boolean): UseReview {
  const cwd = workspaceRoot?.trim() ?? "";
  const bridge = typeof window !== "undefined" ? window.hermesDesktop?.git?.review : undefined;

  const [files, setFiles] = useState<ReviewFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [isRepo, setIsRepo] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [shipInfo, setShipInfo] = useState<ReviewShipInfo>(EMPTY_SHIP);
  const [shipBusy, setShipBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [treeMode, setTreeModeState] = useState<ReviewTreeMode>(() =>
    readStored(TREE_MODE_KEY, "tree", ["tree", "list"]),
  );
  const [commitDefault, setCommitDefaultState] = useState<CommitAction>(() =>
    readStored(COMMIT_DEFAULT_KEY, "commit", ["commit", "commitPush"]),
  );

  const refreshSeq = useRef(0);
  const shipSeq = useRef(0);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedPath;

  // Returns the freshly-fetched list so a follow-up (post-mutation re-select) can
  // act on it without waiting for the state update to flush.
  const refresh = useCallback(async (): Promise<ReviewFile[]> => {
    const seq = (refreshSeq.current += 1);

    if (!active || !cwd || !bridge) {
      setFiles([]);
      // No backend verdict available — stay neutral so the "not a repo" empty
      // state never shows for a bridge/cwd gap (those have their own states).
      setIsRepo(true);
      if (seq === refreshSeq.current) setLoading(false);
      return [];
    }

    setLoading(true);
    try {
      const result = await bridge.list({ repoPath: cwd, scope: "uncommitted", baseRef: null });
      if (seq !== refreshSeq.current) return result.files;
      setFiles(result.files);
      // The backend runs `git rev-parse --is-inside-work-tree`; trust its verdict.
      setIsRepo(result.isRepo);

      // Drop the selection if the file is gone (staged away, reverted) so the
      // diff pane doesn't strand on a ghost.
      const selected = selectedRef.current;
      if (selected && !result.files.some((f) => f.path === selected)) {
        setSelectedPath(null);
        setDiff(null);
      }
      return result.files;
    } catch {
      if (seq === refreshSeq.current) setFiles([]);
      return [];
    } finally {
      if (seq === refreshSeq.current) setLoading(false);
    }
  }, [active, cwd, bridge]);

  const refreshShip = useCallback(async (): Promise<void> => {
    const seq = (shipSeq.current += 1);
    if (!cwd || !bridge) {
      setShipInfo(EMPTY_SHIP);
      return;
    }
    try {
      const info = await bridge.shipInfo({ repoPath: cwd });
      if (seq === shipSeq.current) setShipInfo(info);
    } catch {
      if (seq === shipSeq.current) setShipInfo(EMPTY_SHIP);
    }
  }, [cwd, bridge]);

  const selectFile = useCallback(
    async (file: ReviewFile): Promise<void> => {
      setSelectedPath(file.path);
      if (!bridge || !cwd) {
        setDiff(null);
        return;
      }
      setDiffLoading(true);
      try {
        const next = await bridge.diff({
          repoPath: cwd,
          filePath: file.path,
          scope: "uncommitted",
          baseRef: null,
          staged: file.staged,
        });
        if (selectedRef.current === file.path) setDiff(next || "");
      } catch {
        if (selectedRef.current === file.path) setDiff("");
      } finally {
        if (selectedRef.current === file.path) setDiffLoading(false);
      }
    },
    [bridge, cwd],
  );

  const clearSelection = useCallback(() => {
    setSelectedPath(null);
    setDiff(null);
    setDiffLoading(false);
  }, []);

  // Run a git mutation then re-sync the list and (if a file is still selected)
  // its diff — staging flips which diff applies (cached vs worktree).
  const afterMutation = useCallback(async () => {
    const fresh = await refresh();
    const selected = selectedRef.current;
    const file = selected ? fresh.find((f) => f.path === selected) : undefined;
    if (file) void selectFile(file);
  }, [refresh, selectFile]);

  // Wrap a mutation: clear the error, run, surface failures as an inline banner.
  const run = useCallback((label: string, fn: () => Promise<void>) => {
    setActionError(null);
    void fn().catch((err) => {
      setActionError(`${label}失败：${err instanceof Error ? err.message : String(err)}`);
    });
  }, []);

  const stageAll = useCallback(() => {
    if (!bridge) return;
    run("暂存全部", async () => {
      await bridge.stage({ repoPath: cwd, filePath: null });
      await afterMutation();
    });
  }, [bridge, cwd, run, afterMutation]);

  const revertAll = useCallback(() => {
    if (!bridge) return;
    run("还原全部", async () => {
      await bridge.revert({ repoPath: cwd, filePath: null });
      await afterMutation();
    });
  }, [bridge, cwd, run, afterMutation]);

  const stage = useCallback(
    (path: string) => {
      if (!bridge) return;
      run("暂存", async () => {
        await bridge.stage({ repoPath: cwd, filePath: path });
        await afterMutation();
      });
    },
    [bridge, cwd, run, afterMutation],
  );

  const unstage = useCallback(
    (path: string) => {
      if (!bridge) return;
      run("取消暂存", async () => {
        await bridge.unstage({ repoPath: cwd, filePath: path });
        await afterMutation();
      });
    },
    [bridge, cwd, run, afterMutation],
  );

  const revert = useCallback(
    (path: string) => {
      if (!bridge) return;
      run("还原", async () => {
        await bridge.revert({ repoPath: cwd, filePath: path });
        await afterMutation();
      });
    },
    [bridge, cwd, run, afterMutation],
  );

  // Returns true on success so the caller can clear the message box.
  const commit = useCallback(
    async (message: string, push: boolean): Promise<boolean> => {
      if (!bridge || !cwd || !message.trim() || shipBusy) return false;
      setActionError(null);
      setShipBusy(true);
      try {
        await bridge.commit({ repoPath: cwd, message: message.trim(), push });
        await refresh();
        void refreshShip();
        return true;
      } catch (err) {
        setActionError(`提交失败：${err instanceof Error ? err.message : String(err)}`);
        return false;
      } finally {
        setShipBusy(false);
      }
    },
    [bridge, cwd, shipBusy, refresh, refreshShip],
  );

  // PR button: open the existing PR in the browser, or create one (pushing first)
  // then open it. Caller gates this on shipInfo.ghReady.
  const createOrOpenPr = useCallback(() => {
    if (!bridge || !cwd || shipBusy) return;
    const existing = shipInfo.pr;
    if (existing?.url) {
      void window.hermesDesktop?.openExternalUrl?.({ url: existing.url });
      return;
    }
    setActionError(null);
    setShipBusy(true);
    void bridge
      .createPr({ repoPath: cwd })
      .then(({ url }) => {
        if (url) void window.hermesDesktop?.openExternalUrl?.({ url });
        void refreshShip();
      })
      .catch((err) => {
        setActionError(`创建 PR 失败：${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => setShipBusy(false));
  }, [bridge, cwd, shipBusy, shipInfo.pr, refreshShip]);

  const setTreeMode = useCallback((mode: ReviewTreeMode) => {
    setTreeModeState(mode);
    writeStored(TREE_MODE_KEY, mode);
  }, []);

  const setCommitDefault = useCallback((action: CommitAction) => {
    setCommitDefaultState(action);
    writeStored(COMMIT_DEFAULT_KEY, action);
  }, []);

  const dismissError = useCallback(() => setActionError(null), []);

  // The repo changed under the pane → drop the stale selection up front.
  useEffect(() => {
    clearSelection();
  }, [cwd, clearSelection]);

  // Load when the pane becomes active or the repo changes.
  useEffect(() => {
    if (!active) return;
    void refresh();
    void refreshShip();
  }, [active, refresh, refreshShip]);

  // An outside terminal / agent may have changed the tree while we were away.
  useEffect(() => {
    if (!active) return;
    const onFocus = () => {
      void refresh();
      void refreshShip();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, refresh, refreshShip]);

  const selectedFile = files.find((f) => f.path === selectedPath);

  return {
    files,
    loading,
    hasBridge: Boolean(bridge),
    isRepo,
    selectedPath,
    selectedFile,
    diff,
    diffLoading,
    shipInfo,
    shipBusy,
    actionError,
    treeMode,
    commitDefault,
    refresh: () => void refresh(),
    selectFile: (file) => void selectFile(file),
    clearSelection,
    stageAll,
    revertAll,
    stage,
    unstage,
    revert,
    commit,
    createOrOpenPr,
    dismissError,
    setTreeMode,
    setCommitDefault,
  };
}
