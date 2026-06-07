import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import { Dialog, Popover } from "@hermes/shared-ui";
import {
  Archive,
  ChevronDown,
  Edit3,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type { SessionSummary } from "@hermes/protocol";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { activeSessionIdAtom } from "@/stores/ui";
import { useArchiveSession, useDeleteSessions, useSessions } from "@/hooks/use-sessions";
import { useGateway } from "@/hooks/use-gateway";
import { isSessionRunning } from "@/lib/session-activity";
import { sessionDisplayTitle } from "@/lib/session-title";
import {
  dayKey,
  dayLabel,
  formatTokens,
  isToday,
  relativeTime,
  timeOfDay,
} from "@/lib/format";
import {
  readPinnedSessionIds,
  readSessionTitleOverrides,
  subscribeSessionUiStateChanges,
  togglePinnedSession,
  unpinSessions,
} from "@/lib/session-ui-state";
import {
  normalizeWorkspacePath,
  readSessionWorkspaceMap,
  subscribeWorkspaceChanges,
  workspaceNameFromPath,
} from "@/lib/workspaces";
import { getSourceMeta, groupSourcesByCategory, type SourceMeta } from "@/lib/source-meta";
import {
  readPinnedSources,
  subscribePinnedSourcesChange,
  togglePinnedSource,
} from "@/lib/source-pin";
import { renameSession } from "@/lib/session-rename";
import { TopBar, TopBarActionButton } from "@/components/top-bar/top-bar";
import s from "./history.module.css";

const PAGE_SIZE = 200;
const INLINE_SOURCE_LIMIT = 4;

type StatusFilter = "all" | "running" | "done" | "failed";

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: "全部",
  running: "运行中",
  done: "已完成",
  failed: "失败",
};

function shortId(id: string): string {
  return id.slice(-6);
}

function lastActivitySec(session: SessionSummary): number {
  return session.ended_at ?? session.started_at;
}

interface SessionStatus {
  kind: "running" | "done" | "failed";
  label: string;
}

function classifySession(
  session: SessionSummary,
  liveRunning: boolean,
): SessionStatus {
  if (liveRunning) return { kind: "running", label: "运行中" };
  if (session.end_reason === "error" || session.end_reason === "interrupted") {
    return { kind: "failed", label: session.end_reason === "interrupted" ? "已中止" : "失败" };
  }
  return { kind: "done", label: "已完成" };
}

interface RowMenuProps {
  pinned: boolean;
  disabled?: boolean;
  onTogglePin: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

function RowMenu({ pinned, disabled, onTogglePin, onRename, onArchive, onDelete }: RowMenuProps) {
  return (
    <Popover.Portal>
      <Popover.Content
        className={s.rowMenu}
        align="end"
        side="bottom"
        sideOffset={4}
        role="menu"
        onClick={(event) => event.stopPropagation()}
      >
        <Popover.Close asChild>
          <button type="button" onClick={onTogglePin} role="menuitem" disabled={disabled}>
            {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            {pinned ? "取消置顶" : "置顶"}
          </button>
        </Popover.Close>
        <Popover.Close asChild>
          <button type="button" onClick={onRename} role="menuitem" disabled={disabled}>
            <Edit3 size={13} /> 重命名
          </button>
        </Popover.Close>
        <Popover.Close asChild>
          <button type="button" onClick={onArchive} role="menuitem" disabled={disabled}>
            <Archive size={13} /> 归档
          </button>
        </Popover.Close>
        <Popover.Close asChild>
          <button type="button" onClick={onDelete} role="menuitem" data-tone="danger" disabled={disabled}>
            <Trash2 size={13} /> 删除
          </button>
        </Popover.Close>
      </Popover.Content>
    </Popover.Portal>
  );
}

interface RenameModalProps {
  value: string;
  saving: boolean;
  error: string;
  onChange: (next: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}

function RenameModal({ value, saving, error, onChange, onClose, onSubmit }: RenameModalProps) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={s.modalBackdrop} />
        <Dialog.Content
          className={s.renameModal}
          aria-describedby={error ? "history-rename-error" : undefined}
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (saving) event.preventDefault();
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <Dialog.Title asChild>
              <h2>重命名会话</h2>
            </Dialog.Title>
            <input
              className={s.renameInput}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              autoFocus
              maxLength={80}
            />
            {error ? (
              <div id="history-rename-error" className={s.renameError}>
                {error}
              </div>
            ) : null}
            <div className={s.renameActions}>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className={s.renameCancel}
                  disabled={saving}
                >
                  取消
                </button>
              </Dialog.Close>
              <button type="submit" className={s.renameSubmit} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface DeleteConfirmModalProps {
  sessions: SessionSummary[];
  deleting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

function DeleteConfirmModal({ sessions, deleting, onClose, onConfirm }: DeleteConfirmModalProps) {
  const count = sessions.length;
  const preview = sessions.slice(0, 5);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !deleting) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={s.modalBackdrop} />
        <Dialog.Content
          className={s.confirmModal}
          aria-describedby="history-delete-confirm-desc"
          onEscapeKeyDown={(event) => {
            if (deleting) event.preventDefault();
          }}
        >
          <Dialog.Title asChild>
            <h2>{count === 1 ? "删除会话" : "批量删除会话"}</h2>
          </Dialog.Title>
          <Dialog.Description id="history-delete-confirm-desc" className={s.confirmText}>
            将删除 {count} 个会话，此操作不可撤销。
          </Dialog.Description>
          <div className={s.confirmList}>
            {preview.map((session) => (
              <div key={session.id} className={s.confirmListItem}>
                {sessionDisplayTitle(session)}
              </div>
            ))}
            {count > preview.length ? (
              <div className={s.confirmListMore}>另有 {count - preview.length} 个会话</div>
            ) : null}
          </div>
          <div className={s.confirmActions}>
            <button type="button" className={s.confirmCancel} onClick={onClose} disabled={deleting}>
              取消
            </button>
            <button type="button" className={s.confirmDanger} onClick={onConfirm} disabled={deleting}>
              {deleting ? "删除中…" : "确认删除"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface SourcePopoverProps {
  selected: string | null;
  pinned: Set<string>;
  counts: Map<string, number>;
  onSelect: (key: string | null) => void;
  onTogglePin: (key: string) => void;
  onClose: () => void;
}

function SourcePopover({
  selected,
  pinned,
  counts,
  onSelect,
  onTogglePin,
  onClose,
}: SourcePopoverProps) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const sources = Array.from(counts.entries()).map(([key, count]) => ({ key, count }));
    return groupSourcesByCategory(sources);
  }, [counts]);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (item) =>
            item.label.toLowerCase().includes(q) || item.key.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, query]);

  return (
    <Popover.Portal>
      <Popover.Content
        className={s.popover}
        align="start"
        side="bottom"
        role="dialog"
        aria-label="来源筛选"
      >
        <div className={s.popHead}>
          <Search size={13} />
          <input
            className={s.popSearch}
            placeholder="搜索来源…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        </div>
        <div className={s.popBody}>
          {filteredGroups.length === 0 ? (
            <div className={s.popEmpty}>未找到来源</div>
          ) : (
            filteredGroups.map((group) => (
              <div key={group.group} className={s.popGroup}>
                <div className={s.popGroupLabel}>
                  {group.label} · {group.items.length}
                </div>
                {group.items.map((item) => {
                  const isSelected = selected === item.key;
                  const pinnedHere = pinned.has(item.key);
                  return (
                    <div
                      key={item.key}
                      className={s.popRow}
                      data-checked={isSelected ? "true" : undefined}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => {
                        onSelect(item.key);
                        onClose();
                      }}
                    >
                      <span className={s.popName}>{item.label}</span>
                      <button
                        type="button"
                        className={s.popPin}
                        data-pinned={pinnedHere ? "true" : undefined}
                        onClick={(event) => {
                          event.stopPropagation();
                          onTogglePin(item.key);
                        }}
                        aria-label={pinnedHere ? "取消置顶" : "置顶"}
                        title={pinnedHere ? "取消置顶" : "置顶"}
                      >
                        {pinnedHere ? <Pin size={11} /> : <PinOff size={11} />}
                      </button>
                      <span className={s.popCount}>{counts.get(item.key) ?? 0}</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className={s.popFoot}>
          <button
            type="button"
            className={s.popLink}
            onClick={() => {
              onSelect(null);
              onClose();
            }}
          >
            全部来源
          </button>
          <span className={s.popFootMeta}>
            {selected ? getSourceMeta(selected).label : "未选择"}
          </span>
        </div>
      </Popover.Content>
    </Popover.Portal>
  );
}

export function HistoryRoute() {
  const navigate = useNavigate();
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const { data, isLoading, isError } = useSessions(PAGE_SIZE, 0);
  const archiveSession = useArchiveSession();
  const deleteSessions = useDeleteSessions();
  const { setSessionTitle, resumeSession } = useGateway();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<SessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [bulkDeleteMode, setBulkDeleteMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const [deleteTargets, setDeleteTargets] = useState<SessionSummary[] | null>(null);
  const [deleteFeedback, setDeleteFeedback] = useState<string | null>(null);

  const [titleOverrides, setTitleOverrides] = useState(readSessionTitleOverrides);
  const [workspaceMap, setWorkspaceMap] = useState(readSessionWorkspaceMap);
  const [pinnedSources, setPinnedSources] = useState<Set<string>>(readPinnedSources);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<Set<string>>(readPinnedSessionIds);

  useEffect(
    () =>
      subscribeSessionUiStateChanges(() => {
        setTitleOverrides(readSessionTitleOverrides());
        setPinnedSessionIds(readPinnedSessionIds());
      }),
    [],
  );
  useEffect(
    () => subscribeWorkspaceChanges(() => setWorkspaceMap(readSessionWorkspaceMap())),
    [],
  );
  useEffect(
    () => subscribePinnedSourcesChange(() => setPinnedSources(readPinnedSources())),
    [],
  );

  const sessions = useMemo(
    () =>
      (data?.sessions ?? []).map((session) => {
        const overridden = titleOverrides[session.id];
        return overridden ? { ...session, title: overridden } : session;
      }),
    [data?.sessions, titleOverrides],
  );

  useEffect(() => {
    if (!data || data.total > sessions.length || pinnedSessionIds.size === 0) return;
    const liveIds = new Set(sessions.map((session) => session.id));
    const staleIds = Array.from(pinnedSessionIds).filter((id) => !liveIds.has(id));
    if (staleIds.length > 0) setPinnedSessionIds(unpinSessions(staleIds));
  }, [data, pinnedSessionIds, sessions]);

  // status counts (across all sessions, ignoring source/search filters)
  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { all: 0, running: 0, done: 0, failed: 0 };
    for (const session of sessions) {
      counts.all += 1;
      const live = isSessionRunning(session, runtimeBySession);
      const status = classifySession(session, live).kind;
      counts[status] += 1;
    }
    return counts;
  }, [runtimeBySession, sessions]);

  // source counts (across sessions matching status + search, ignoring source filter)
  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const q = searchQuery.trim().toLowerCase();
    for (const session of sessions) {
      const live = isSessionRunning(session, runtimeBySession);
      const status = classifySession(session, live).kind;
      if (statusFilter !== "all" && status !== statusFilter) continue;
      if (q) {
        const haystack =
          `${session.title ?? ""} ${session.preview ?? ""} ${session.id}`.toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      const key = getSourceMeta(session.source).key;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [runtimeBySession, searchQuery, sessions, statusFilter]);

  // inline sources: pinned first (sorted by count), then top remaining by count, capped to INLINE_SOURCE_LIMIT
  const inlineSourceKeys = useMemo(() => {
    const entries = Array.from(sourceCounts.entries());
    const pinnedEntries = entries
      .filter(([key]) => pinnedSources.has(key))
      .sort((a, b) => b[1] - a[1]);
    const otherEntries = entries
      .filter(([key]) => !pinnedSources.has(key))
      .sort((a, b) => b[1] - a[1]);
    const ordered = [...pinnedEntries, ...otherEntries];
    return ordered.slice(0, INLINE_SOURCE_LIMIT).map(([key]) => key);
  }, [pinnedSources, sourceCounts]);

  const overflowCount = Math.max(0, sourceCounts.size - inlineSourceKeys.length);

  // visible sessions after all filters, with day grouping
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matches: SessionSummary[] = [];
    for (const session of sessions) {
      const live = isSessionRunning(session, runtimeBySession);
      const status = classifySession(session, live).kind;
      if (statusFilter !== "all" && status !== statusFilter) continue;
      if (selectedSource) {
        const sourceKey = getSourceMeta(session.source).key;
        if (sourceKey !== selectedSource) continue;
      }
      if (q) {
        const haystack =
          `${session.title ?? ""} ${session.preview ?? ""} ${session.id}`.toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      matches.push(session);
    }
    matches.sort((a, b) => lastActivitySec(b) - lastActivitySec(a));
    return matches;
  }, [runtimeBySession, searchQuery, selectedSource, sessions, statusFilter]);

  const dayGroups = useMemo(() => {
    const groups = new Map<string, { label: string; sessions: SessionSummary[]; sortKey: number }>();
    for (const session of filtered) {
      const ts = lastActivitySec(session);
      const key = dayKey(ts);
      const existing = groups.get(key);
      if (existing) {
        existing.sessions.push(session);
      } else {
        groups.set(key, { label: dayLabel(ts), sessions: [session], sortKey: ts });
      }
    }
    return Array.from(groups.values()).sort((a, b) => b.sortKey - a.sortKey);
  }, [filtered]);

  const visibleSessionIds = useMemo(() => filtered.map((session) => session.id), [filtered]);
  const visibleSessionIdSet = useMemo(() => new Set(visibleSessionIds), [visibleSessionIds]);
  const selectedSessions = useMemo(
    () => filtered.filter((session) => selectedSessionIds.has(session.id)),
    [filtered, selectedSessionIds],
  );
  const allVisibleSelected = visibleSessionIds.length > 0 && visibleSessionIds.every((id) => selectedSessionIds.has(id));

  useEffect(() => {
    if (!bulkDeleteMode) return;
    setSelectedSessionIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => visibleSessionIdSet.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [bulkDeleteMode, visibleSessionIdSet]);

  const onTogglePinSource = useCallback((key: string) => {
    setPinnedSources(togglePinnedSource(key));
  }, []);

  const onTogglePinSession = useCallback((sessionId: string) => {
    setPinnedSessionIds(togglePinnedSession(sessionId));
  }, []);

  const toggleSelectedSession = useCallback((sessionId: string, checked: boolean) => {
    setSelectedSessionIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);

  const clearSelectedSessions = useCallback(() => {
    setSelectedSessionIds(new Set());
  }, []);

  const selectVisibleSessions = useCallback(() => {
    setSelectedSessionIds(new Set(visibleSessionIds));
  }, [visibleSessionIds]);

  const startBulkDeleteMode = useCallback(() => {
    setOpenMenuId(null);
    setDeleteFeedback(null);
    setSelectedSessionIds(new Set());
    setBulkDeleteMode(true);
  }, []);

  const stopBulkDeleteMode = useCallback(() => {
    if (deleteSessions.isPending) return;
    setBulkDeleteMode(false);
    setSelectedSessionIds(new Set());
    setDeleteFeedback(null);
  }, [deleteSessions.isPending]);

  const activeSessionId = useAtomValue(activeSessionIdAtom);
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const goSession = useCallback(
    (session: SessionSummary) => {
      if (bulkDeleteMode) {
        toggleSelectedSession(session.id, !selectedSessionIds.has(session.id));
        return;
      }
      // Atom is the source of truth (#53). Set synchronously *before*
      // navigate so any async work that mounts as part of the detail
      // route reads the post-click value, not the previous one.
      setActiveSessionId(session.id);
      navigate(`/tasks/${session.id}`);
    },
    [bulkDeleteMode, navigate, selectedSessionIds, setActiveSessionId, toggleSelectedSession],
  );

  const startRename = useCallback((session: SessionSummary) => {
    setOpenMenuId(null);
    setRenamingSession(session);
    setRenameValue((session.title || session.preview || session.id).replace(/\s+/g, " ").trim());
    setRenameError("");
  }, []);

  const closeRename = useCallback(() => {
    setRenamingSession(null);
    setRenameValue("");
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
      archiveSession.mutate(session.id);
    },
    [archiveSession],
  );

  const openDeleteDialog = useCallback((targets: SessionSummary[]) => {
    const uniqueTargets = Array.from(new Map(targets.map((session) => [session.id, session])).values());
    if (uniqueTargets.length === 0) return;
    setOpenMenuId(null);
    setDeleteFeedback(null);
    setDeleteTargets(uniqueTargets);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    if (!deleteSessions.isPending) setDeleteTargets(null);
  }, [deleteSessions.isPending]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTargets?.length) return;
    const targetIds = deleteTargets.map((session) => session.id);
    const result = await deleteSessions.mutateAsync(targetIds);
    if (result.succeededIds.length > 0) {
      unpinSessions(result.succeededIds);
      setPinnedSessionIds(readPinnedSessionIds());
      setSelectedSessionIds((prev) => {
        const next = new Set(prev);
        for (const id of result.succeededIds) next.delete(id);
        return next;
      });
      if (activeSessionId && result.succeededIds.includes(activeSessionId)) {
        setActiveSessionId(null);
      }
    }
    if (result.failureCount > 0) {
      const sample = result.failed[0]?.error ? `：${result.failed[0].error}` : "";
      setDeleteFeedback(`已删除 ${result.successCount} 个会话，${result.failureCount} 个删除失败${sample}`);
    } else {
      setDeleteFeedback(null);
      setBulkDeleteMode(false);
      setSelectedSessionIds(new Set());
    }
    setDeleteTargets(null);
  }, [activeSessionId, deleteSessions, deleteTargets, setActiveSessionId]);

  const totalTokens = useMemo(
    () =>
      filtered.reduce(
        (sum, session) => sum + (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
        0,
      ),
    [filtered],
  );

  const todayTokens = useMemo(() => {
    let tokens = 0;
    for (const session of sessions) {
      if (!isToday(lastActivitySec(session))) continue;
      tokens += (session.input_tokens ?? 0) + (session.output_tokens ?? 0);
    }
    return tokens;
  }, [sessions]);

  return (
    <main className={s.page}>
      <TopBar
        title="对话历史"
        sub={isLoading ? "加载中…" : `${filtered.length} / ${sessions.length} 个会话`}
        right={
          <>
            <span className={s.headerStat}>
              今日 <span className={s.headerStatValue}>{formatTokens(todayTokens)} tokens</span>
            </span>
            <TopBarActionButton
              onClick={startBulkDeleteMode}
              disabled={bulkDeleteMode || deleteSessions.isPending || filtered.length === 0}
            >
              <Trash2 size={13} />
              批量删除
            </TopBarActionButton>
            <TopBarActionButton onClick={() => navigate("/")}>
              <Plus size={13} />
              新对话
            </TopBarActionButton>
          </>
        }
      />

      <div className={s.filters}>
        <div className={s.seg} role="tablist" aria-label="状态筛选">
          {(Object.keys(STATUS_LABELS) as StatusFilter[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={statusFilter === key}
              className={s.segItem}
              data-active={statusFilter === key ? "true" : undefined}
              onClick={() => setStatusFilter(key)}
            >
              {STATUS_LABELS[key]}
              <span className={s.segCount}>{statusCounts[key]}</span>
            </button>
          ))}
        </div>

        <div className={s.segAnchor}>
          <div className={s.seg} role="radiogroup" aria-label="来源筛选">
            <button
              type="button"
              role="radio"
              aria-checked={selectedSource === null}
              className={s.segItem}
              data-active={selectedSource === null ? "true" : undefined}
              onClick={() => setSelectedSource(null)}
            >
              全部
            </button>
            {inlineSourceKeys.map((key) => {
              const meta = getSourceMeta(key);
              const active = selectedSource === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={s.segItem}
                  data-active={active ? "true" : undefined}
                  onClick={() => setSelectedSource(active ? null : key)}
                >
                  {meta.label}
                  <span className={s.segCount}>{sourceCounts.get(key) ?? 0}</span>
                </button>
              );
            })}
            {overflowCount > 0 ? (
              <Popover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    className={s.segItem}
                    data-active={popoverOpen ? "true" : undefined}
                  >
                    更多
                    <span className={s.segBadge}>+{overflowCount}</span>
                    <ChevronDown size={12} className={popoverOpen ? s.chevOpen : undefined} />
                  </button>
                </Popover.Trigger>
                <SourcePopover
                  selected={selectedSource}
                  pinned={pinnedSources}
                  counts={sourceCounts}
                  onSelect={setSelectedSource}
                  onTogglePin={onTogglePinSource}
                  onClose={() => setPopoverOpen(false)}
                />
              </Popover.Root>
            ) : null}
          </div>
        </div>

        <div className={s.searchBox}>
          <Search size={13} />
          <input
            type="search"
            placeholder="搜索标题与会话 ID…"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
      </div>

      {bulkDeleteMode ? (
        <div className={s.bulkBar} data-active={selectedSessionIds.size > 0 ? "true" : undefined}>
          {deleteFeedback ? <span className={s.bulkFeedback}>{deleteFeedback}</span> : null}
          <span>
            已选择 {selectedSessionIds.size} 个会话
            {filtered.length > 0 ? ` · 当前筛选 ${filtered.length} 个` : ""}
          </span>
          <button type="button" onClick={selectVisibleSessions} disabled={visibleSessionIds.length === 0 || allVisibleSelected || deleteSessions.isPending}>
            选择当前筛选结果
          </button>
          <button type="button" onClick={clearSelectedSessions} disabled={selectedSessionIds.size === 0 || deleteSessions.isPending}>
            清空选择
          </button>
          <button
            type="button"
            className={s.bulkDanger}
            onClick={() => openDeleteDialog(selectedSessions)}
            disabled={selectedSessions.length === 0 || deleteSessions.isPending}
          >
            <Trash2 size={13} />
            删除所选
          </button>
          <button type="button" onClick={stopBulkDeleteMode} disabled={deleteSessions.isPending}>
            退出批量删除
          </button>
        </div>
      ) : null}

      <div className={s.scroll}>
        {isError ? (
          <div className={s.errorState}>无法加载会话列表，请检查 Dashboard 服务。</div>
        ) : isLoading ? (
          <div className={s.emptyState}>加载会话中…</div>
        ) : dayGroups.length === 0 ? (
          <div className={s.emptyState}>
            {sessions.length === 0 ? "暂无会话" : "没有匹配当前筛选的会话"}
          </div>
        ) : (
          dayGroups.map((group, groupIdx) => {
            const dayTokens = group.sessions.reduce(
              (sum, session) =>
                sum + (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
              0,
            );
            return (
              <section key={group.label + group.sortKey} className={s.dayGroup}>
                <div className={s.dayHead}>
                  <span className={s.dayLabel}>{group.label}</span>
                  <span className={s.dayCount}>{group.sessions.length} 个会话</span>
                  <span className={s.dayTotals}>
                    {formatTokens(dayTokens)} tokens
                  </span>
                </div>

                {groupIdx === 0 ? (
                  <div className={s.colHead} data-bulk={bulkDeleteMode ? "true" : undefined} aria-hidden="true">
                    {bulkDeleteMode ? <span /> : null}
                    <span>ID</span>
                    <span>标题</span>
                    <span>来源</span>
                    <span>模型</span>
                    <span>工作区</span>
                    <span>更新</span>
                    <span />
                  </div>
                ) : null}

                {group.sessions.map((session) => {
                  const live = isSessionRunning(session, runtimeBySession);
                  const status = classifySession(session, live);
                  const meta = getSourceMeta(session.source);
                  const selected = selectedSessionIds.has(session.id);
                  const pinned = pinnedSessionIds.has(session.id);
                  const workspacePath = normalizeWorkspacePath(workspaceMap[session.id]);
                  const workspaceName = workspacePath
                    ? workspaceNameFromPath(workspacePath)
                    : "";
                  const ts = lastActivitySec(session);
                  const updatedDisplay =
                    isToday(ts) && status.kind === "running"
                      ? `${timeOfDay(ts)} 启动`
                      : isToday(ts)
                        ? timeOfDay(ts)
                        : relativeTime(ts);
                  return (
                    <div
                      key={session.id}
                      className={s.convRow}
                      data-status={status.kind}
                      data-selected={selected ? "true" : undefined}
                      data-bulk={bulkDeleteMode ? "true" : undefined}
                      onClick={() => goSession(session)}
                    >
                      {bulkDeleteMode ? (
                        <span className={s.cellSelect}>
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={deleteSessions.isPending}
                            aria-label={`选择会话 ${sessionDisplayTitle(session)}`}
                            onChange={(event) => toggleSelectedSession(session.id, event.currentTarget.checked)}
                            onClick={(event) => event.stopPropagation()}
                          />
                        </span>
                      ) : null}
                      <span className={s.cellId}>{shortId(session.id)}</span>
                      <span className={s.cellTitle}>
                        {status.kind === "running" ? (
                          <span className={s.dotLive} aria-hidden />
                        ) : status.kind === "failed" ? (
                          <span className={s.dotFail} aria-hidden />
                        ) : null}
                        {pinned ? <Pin size={12} className={s.titlePin} aria-hidden /> : null}
                        <span className={s.titleText}>{sessionDisplayTitle(session)}</span>
                      </span>
                      <SourceBadge meta={meta} />
                      <span className={s.cellMono}>{session.model || "—"}</span>
                      <span className={s.cellMono} title={workspacePath || undefined}>
                        {workspaceName || "—"}
                      </span>
                      <span className={s.cellTimestamp}>{updatedDisplay}</span>
                      <Popover.Root
                        open={openMenuId === session.id}
                        onOpenChange={(open) => setOpenMenuId(open ? session.id : null)}
                      >
                        <Popover.Trigger asChild>
                          <button
                            type="button"
                            className={s.cellMore}
                            aria-label="会话操作"
                            disabled={deleteSessions.isPending}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <MoreHorizontal size={14} />
                          </button>
                        </Popover.Trigger>
                        <RowMenu
                          pinned={pinned}
                          disabled={deleteSessions.isPending}
                          onTogglePin={() => onTogglePinSession(session.id)}
                          onRename={() => startRename(session)}
                          onArchive={() => handleArchive(session)}
                          onDelete={() => openDeleteDialog([session])}
                        />
                      </Popover.Root>
                    </div>
                  );
                })}
              </section>
            );
          })
        )}
      </div>

      <div className={s.foot}>
        <span>
          共 {filtered.length} 个会话 · {formatTokens(totalTokens)} tokens
        </span>
        {data && data.total > sessions.length ? (
          <span className={s.footNote}>展示前 {sessions.length} 条 / 共 {data.total} 条</span>
        ) : null}
      </div>

      {renamingSession ? (
        <RenameModal
          value={renameValue}
          saving={renameSaving}
          error={renameError}
          onChange={(next) => {
            setRenameValue(next);
            if (renameError) setRenameError("");
          }}
          onClose={closeRename}
          onSubmit={submitRename}
        />
      ) : null}

      {deleteTargets ? (
        <DeleteConfirmModal
          sessions={deleteTargets}
          deleting={deleteSessions.isPending}
          onClose={closeDeleteDialog}
          onConfirm={confirmDelete}
        />
      ) : null}
    </main>
  );
}

function SourceBadge({ meta }: { meta: SourceMeta }) {
  return (
    <span className={s.sourceChip} data-tone={meta.tone}>
      {meta.label}
    </span>
  );
}
