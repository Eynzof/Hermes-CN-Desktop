import { useCallback, useState } from "react";
import type { SessionSummary } from "@hermes/protocol";
import { renameSession, type RenameDeps } from "@/lib/session-rename";
import { togglePinnedSession, unpinSessions } from "@/lib/session-ui-state";

export interface UseSessionRowActionsOptions {
  /** Delete sessions and resolve with the ids that actually succeeded. */
  deleteSessions: (ids: string[]) => Promise<{ succeededIds: string[] } | undefined>;
  /** True while a delete request is in flight (disables menu/confirm buttons). */
  isDeleting: boolean;
  /** Gateway rename deps, typically destructured from `useGateway()`. */
  setSessionTitle: RenameDeps["setSessionTitle"];
  resumeSession: RenameDeps["resumeSession"];
  /** Archive a single session, typically `useArchiveSession().mutate`. */
  archive: (id: string) => void;
  /** Side effect after a successful delete (e.g. clear active session / route). */
  onDeleted?: (succeededIds: string[]) => void;
}

export interface UseSessionRowActions {
  // menu
  openMenuId: string | null;
  setOpenMenuId: (id: string | null) => void;
  /** True while a delete request is in flight (mirrors the injected option). */
  isDeleting: boolean;
  // pin (state itself lives in the caller via subscribeSessionUiStateChanges)
  togglePin: (sessionId: string) => void;
  // rename
  renamingSession: SessionSummary | null;
  renameValue: string;
  renameError: string;
  renameSaving: boolean;
  startRename: (session: SessionSummary) => void;
  closeRename: () => void;
  setRenameValue: (next: string) => void;
  submitRename: () => Promise<void>;
  // archive
  handleArchive: (session: SessionSummary) => void;
  // delete (array form works for single or many)
  deleteTargets: SessionSummary[] | null;
  openDeleteDialog: (targets: SessionSummary[]) => void;
  closeDeleteDialog: () => void;
  confirmDelete: () => Promise<void>;
}

/**
 * State machine for a single session's row actions (pin / rename / archive /
 * delete) backing the shared `SessionRowMenu` + rename/delete modals.
 *
 * Deliberately excludes bulk-delete selection mode — that stays in the history
 * page. Pin state is not owned here: callers already track pinned ids via
 * `subscribeSessionUiStateChanges`, so `togglePin` only flips persistence and
 * lets the caller's subscription refresh.
 */
export function useSessionRowActions({
  deleteSessions,
  isDeleting,
  setSessionTitle,
  resumeSession,
  archive,
  onDeleted,
}: UseSessionRowActionsOptions): UseSessionRowActions {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<SessionSummary | null>(null);
  const [renameValue, setRenameValueState] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<SessionSummary[] | null>(null);

  const togglePin = useCallback((sessionId: string) => {
    togglePinnedSession(sessionId);
  }, []);

  // Editing the field clears any prior error, mirroring history's onChange.
  const setRenameValue = useCallback((next: string) => {
    setRenameValueState(next);
    setRenameError("");
  }, []);

  const startRename = useCallback((session: SessionSummary) => {
    setOpenMenuId(null);
    setRenamingSession(session);
    setRenameValueState(
      (session.title || session.preview || session.id).replace(/\s+/g, " ").trim(),
    );
    setRenameError("");
  }, []);

  const closeRename = useCallback(() => {
    setRenamingSession(null);
    setRenameValueState("");
    setRenameError("");
  }, []);

  const submitRename = useCallback(async () => {
    const session = renamingSession;
    if (!session) return;
    const title = renameValue.trim();
    if (!title) {
      setRenameError("请输入会话名称");
      return;
    }
    setRenameSaving(true);
    setRenameError("");
    try {
      await renameSession(session.id, title, { setSessionTitle, resumeSession });
      closeRename();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "重命名失败");
    } finally {
      setRenameSaving(false);
    }
  }, [closeRename, renameValue, renamingSession, resumeSession, setSessionTitle]);

  const handleArchive = useCallback(
    (session: SessionSummary) => {
      setOpenMenuId(null);
      archive(session.id);
    },
    [archive],
  );

  const openDeleteDialog = useCallback((targets: SessionSummary[]) => {
    const uniqueTargets = Array.from(
      new Map(targets.map((session) => [session.id, session])).values(),
    );
    if (uniqueTargets.length === 0) return;
    setOpenMenuId(null);
    setDeleteTargets(uniqueTargets);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    if (!isDeleting) setDeleteTargets(null);
  }, [isDeleting]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTargets?.length) return;
    const ids = deleteTargets.map((session) => session.id);
    const result = await deleteSessions(ids);
    const succeededIds = result?.succeededIds ?? [];
    if (succeededIds.length > 0) {
      // Defensive: the delete mutation already unpins, but unpinSessions is
      // idempotent (no write/event when nothing changed).
      unpinSessions(succeededIds);
      onDeleted?.(succeededIds);
    }
    setDeleteTargets(null);
  }, [deleteSessions, deleteTargets, onDeleted]);

  return {
    openMenuId,
    setOpenMenuId,
    isDeleting,
    togglePin,
    renamingSession,
    renameValue,
    renameError,
    renameSaving,
    startRename,
    closeRename,
    setRenameValue,
    submitRename,
    handleArchive,
    deleteTargets,
    openDeleteDialog,
    closeDeleteDialog,
    confirmDelete,
  };
}
