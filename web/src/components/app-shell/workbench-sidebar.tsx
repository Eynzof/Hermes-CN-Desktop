import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useLocation } from "react-router-dom";
import { Popover } from "@hermes/shared-ui";
import { Folder, MessageSquare, MoreHorizontal, Plus, Users } from "lucide-react";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { activeSessionIdAtom } from "@/stores/ui";
import { useActiveProfileName } from "@/hooks/use-profiles";
import {
  prefetchSessionMessages,
  useArchiveSession,
  useDeleteSessions,
  useSessions,
} from "@/hooks/use-sessions";
import { useGateway } from "@/hooks/use-gateway";
import { groupChatDialogOpenAtom } from "@/components/sidebar/create-group-chat-dialog";
import {
  isSessionRunning,
  mergeLiveRuntimeSessions,
  sessionIdMatches,
} from "@/lib/session-activity";
import { sessionDisplayTitle } from "@/lib/session-title";
import {
  readPinnedSessionIds,
  readSessionTitleOverrides,
  subscribeSessionUiStateChanges,
  unpinSessions,
} from "@/lib/session-ui-state";
import { deriveSidebarSessionLists } from "@/lib/sidebar-session-lists";
import {
  SessionDeleteModal,
  SessionRenameModal,
  SessionRowMenu,
  useSessionRowActions,
  type UseSessionRowActions,
} from "@/components/session-actions";
import {
  readPinnedWorkspaceProjectPaths,
  readSessionWorkspaceMap,
  readWorkspaceProjects,
  subscribeWorkspaceChanges,
  unpinWorkspaceProjects,
  workspaceNameFromPath,
  type WorkspaceProject,
} from "@/lib/workspaces";
import type { SessionSummary } from "@hermes/protocol";
import s from "./workbench-sidebar.module.css";

function relTime(unixSec: number, now: Date) {
  const d = new Date(unixSec * 1000);
  if (d.toDateString() === now.toDateString()) {
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function elapsed(unixSec: number, now: Date) {
  const ms = now.getTime() - unixSec * 1000;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  }
  return `${Math.floor(ms / 3_600_000)}h`;
}

function modelShort(model: string | null | undefined) {
  if (!model) return "—";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function sectionLabel(index: number, label: string): string {
  return `§${index.toString().padStart(2, "0")} · ${label}`;
}

function KanbanQuickIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.2" y="2.4" width="11.6" height="11.2" rx="1.8" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 4.8v6.4M10 4.8v6.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <rect x="3.8" y="4.5" width="2.2" height="3" rx="0.6" fill="currentColor" opacity="0.8" />
      <rect x="6.9" y="4.5" width="2.2" height="4.8" rx="0.6" fill="currentColor" opacity="0.58" />
      <rect x="10" y="4.5" width="2.2" height="2.6" rx="0.6" fill="currentColor" opacity="0.72" />
    </svg>
  );
}

interface SessionRowProps {
  session: SessionSummary;
  state: "live" | "ok" | "err" | "idle";
  active: boolean;
  meta: string;
  projectName?: string;
  pinned: boolean;
  menuDisabled?: boolean;
  actions: UseSessionRowActions;
  onClick: () => void;
  onHover?: () => void;
}

function SessionRow({
  session,
  state,
  active,
  meta,
  projectName,
  pinned,
  menuDisabled = false,
  actions,
  onClick,
  onHover,
}: SessionRowProps) {
  const title = sessionDisplayTitle(session);
  const dotState = state === "idle" ? undefined : state;
  const actionMenuDisabled = menuDisabled || actions.isDeleting;
  return (
    // role=button (not a real <button>) so the "⋯" trigger can nest inside it.
    <div
      className={s.sessionRow}
      data-active={active ? "true" : undefined}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      onMouseEnter={onHover}
      onFocus={onHover}
      title={title}
    >
      <div className={s.rowMain}>
        <div className={s.ttl}>
          <span className={s.dot} data-state={dotState} />
          <span className={s.ttlText}>{title}</span>
        </div>
        <div className={s.meta}>
          <span className={s.metaText}>{meta}</span>
          {projectName ? (
            <span className={s.metaProject} title={projectName}>
              {projectName}
            </span>
          ) : null}
        </div>
      </div>
      <Popover.Root
        open={!actionMenuDisabled && actions.openMenuId === session.id}
        onOpenChange={(open) => {
          actions.setOpenMenuId(open && !actionMenuDisabled ? session.id : null);
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            className={s.rowMore}
            aria-label="会话操作"
            title={menuDisabled ? "运行中任务暂不可操作" : "会话操作"}
            disabled={actionMenuDisabled}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <MoreHorizontal size={14} />
          </button>
        </Popover.Trigger>
        <SessionRowMenu
          pinned={pinned}
          disabled={actionMenuDisabled}
          onTogglePin={() => actions.togglePin(session.id)}
          onRename={() => actions.startRename(session)}
          onArchive={() => actions.handleArchive(session)}
          onDelete={() => actions.openDeleteDialog([session])}
        />
      </Popover.Root>
    </div>
  );
}

export function WorkbenchSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const setActiveId = useSetAtom(activeSessionIdAtom);
  const setGroupDialogOpen = useSetAtom(groupChatDialogOpenAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const queryClient = useQueryClient();
  const profile = useActiveProfileName();
  const { data } = useSessions();
  const archiveSession = useArchiveSession();
  const deleteSessions = useDeleteSessions();
  const { setSessionTitle, resumeSession } = useGateway();
  const [titleOverrides, setTitleOverrides] = useState(readSessionTitleOverrides);
  const [pinnedSessionIds, setPinnedSessionIds] = useState(readPinnedSessionIds);
  const [projects, setProjects] = useState<WorkspaceProject[]>(readWorkspaceProjects);
  const [pinnedProjectPaths, setPinnedProjectPaths] = useState(readPinnedWorkspaceProjectPaths);
  const [sessionWorkspaceMap, setSessionWorkspaceMap] = useState(readSessionWorkspaceMap);

  useEffect(
    () =>
      subscribeSessionUiStateChanges(() => {
        setTitleOverrides(readSessionTitleOverrides());
        setPinnedSessionIds(readPinnedSessionIds());
      }),
    [],
  );
  useEffect(
    () =>
      subscribeWorkspaceChanges(() => {
        setProjects(readWorkspaceProjects());
        setPinnedProjectPaths(readPinnedWorkspaceProjectPaths());
        setSessionWorkspaceMap(readSessionWorkspaceMap());
      }),
    [],
  );

  const sessions = useMemo(
    () =>
      mergeLiveRuntimeSessions(
        (data?.sessions ?? []).map((sess) => {
          const override = titleOverrides[sess.id];
          return override ? { ...sess, title: override } : sess;
        }),
        runtimeBySession,
      ),
    [data?.sessions, runtimeBySession, titleOverrides],
  );

  useEffect(() => {
    if (!data || data.total > sessions.length || pinnedSessionIds.size === 0) return;
    const liveIds = new Set(sessions.map((session) => session.id));
    const staleIds = Array.from(pinnedSessionIds).filter((id) => !liveIds.has(id));
    if (staleIds.length > 0) setPinnedSessionIds(unpinSessions(staleIds));
  }, [data, pinnedSessionIds, sessions]);

  const now = new Date();

  const { active, pinned, recent } = useMemo(
    () =>
      deriveSidebarSessionLists(
        sessions,
        pinnedSessionIds,
        (session) => isSessionRunning(session, runtimeBySession),
      ),
    [pinnedSessionIds, runtimeBySession, sessions],
  );

  const pinnedProjects = useMemo(
    () => {
      const projectByPath = new Map(projects.map((project) => [project.path, project]));
      return Array.from(pinnedProjectPaths).flatMap((path) => {
        const project = projectByPath.get(path);
        return project ? [project] : [];
      });
    },
    [pinnedProjectPaths, projects],
  );

  const projectNameBySessionId = useMemo(() => {
    const projectNameByPath = new Map(projects.map((project) => [project.path, project.name]));
    return new Map(
      Object.entries(sessionWorkspaceMap).flatMap(([sessionId, workspacePath]) => {
        const projectName = projectNameByPath.get(workspacePath) ?? workspaceNameFromPath(workspacePath);
        return projectName ? [[sessionId, projectName]] : [];
      }),
    );
  }, [projects, sessionWorkspaceMap]);

  useEffect(() => {
    if (pinnedProjectPaths.size === 0) return;
    const livePaths = new Set(projects.map((project) => project.path));
    const stalePaths = Array.from(pinnedProjectPaths).filter((path) => !livePaths.has(path));
    if (stalePaths.length > 0) setPinnedProjectPaths(unpinWorkspaceProjects(stalePaths));
  }, [pinnedProjectPaths, projects]);

  const goSession = (sess: SessionSummary) => {
    setActiveId(sess.id);
    navigate(`/tasks/${sess.id}`);
  };

  const hoverSession = (sess: SessionSummary) => {
    prefetchSessionMessages(queryClient, profile, sess.id);
  };

  const activeSessionId = location.pathname.startsWith("/tasks/")
    ? decodeURIComponent(location.pathname.slice("/tasks/".length))
    : null;

  const onSessionsDeleted = useCallback(
    (succeededIds: string[]) => {
      // If the session being viewed was deleted, leave its detail route so we
      // don't fall back to loading a now-missing session id.
      if (activeSessionId && succeededIds.includes(activeSessionId)) {
        setActiveId(null);
        navigate("/");
      }
    },
    [activeSessionId, navigate, setActiveId],
  );
  const rowActions = useSessionRowActions({
    deleteSessions: (ids) => deleteSessions.mutateAsync(ids),
    isDeleting: deleteSessions.isPending,
    setSessionTitle,
    resumeSession,
    archive: archiveSession.mutate,
    onDeleted: onSessionsDeleted,
  });

  const showPinned = pinned.length > 0;
  const pinnedProjectSectionIndex = showPinned ? 3 : 2;
  const recentSectionIndex = pinnedProjectSectionIndex + 1;
  const activeSectionLabel = sectionLabel(1, "进行中");
  const pinnedSessionSectionLabel = sectionLabel(2, "置顶对话");
  const pinnedProjectSectionLabel = sectionLabel(pinnedProjectSectionIndex, "置顶项目");
  const recentSectionLabel = sectionLabel(recentSectionIndex, "最近对话");

  return (
    <aside className={s.sidebar}>
      <button type="button" className={s.newTask} onClick={() => navigate("/")}>
        <span className={s.newTaskLead}>
          <span className={s.entryIcon}>
            <Plus size={16} strokeWidth={2.2} />
          </span>
          <span className={s.entryLabel}>新建对话</span>
        </span>
        <span className={s.newTaskKbd}>⌘ N</span>
      </button>

      <div className={s.quickNav}>
        <button
          type="button"
          className={s.quickNavButton}
          onClick={() => setGroupDialogOpen(true)}
        >
          <span className={s.entryIcon}>
            <Users size={16} />
          </span>
          <span className={s.entryLabel}>新建群聊</span>
        </button>
        <button
          type="button"
          className={s.quickNavButton}
          data-active={location.pathname.startsWith("/history") ? "true" : undefined}
          onClick={() => navigate("/history")}
        >
          <span className={s.entryIcon}>
            <MessageSquare size={16} />
          </span>
          <span className={s.entryLabel}>对话历史</span>
          <span className={s.entryCommand}>/history</span>
        </button>
        <button
          type="button"
          className={s.quickNavButton}
          data-active={location.pathname.startsWith("/projects") ? "true" : undefined}
          onClick={() => navigate("/projects")}
        >
          <span className={s.entryIcon}>
            <Folder size={16} />
          </span>
          <span className={s.entryLabel}>工作空间</span>
          <span className={s.entryCommand}>/workspace</span>
        </button>
        <button
          type="button"
          className={s.quickNavButton}
          data-active={location.pathname.startsWith("/kanban") ? "true" : undefined}
          onClick={() => navigate("/kanban")}
        >
          <span className={s.entryIcon}>
            <KanbanQuickIcon />
          </span>
          <span className={s.entryLabel}>看板</span>
          <span className={s.entryCommand}>/kanban</span>
        </button>
      </div>

      <div className={s.scrollY}>
        <section className={s.section}>
          <div className={s.label}>
            <span>{activeSectionLabel}</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          {active.length === 0 ? (
            <div className={s.empty}>暂无运行任务</div>
          ) : (
            active.map((sess) => (
              <SessionRow
                key={sess.id}
                session={sess}
                state="live"
                active={sessionIdMatches(sess.id, activeSessionId)}
                meta={`${modelShort(sess.model)} · ${elapsed(sess.started_at, now)}`}
                projectName={projectNameBySessionId.get(sess.id)}
                pinned={pinnedSessionIds.has(sess.id)}
                menuDisabled
                actions={rowActions}
                onClick={() => goSession(sess)}
                onHover={() => hoverSession(sess)}
              />
            ))
          )}
        </section>

        {showPinned ? (
          <section className={s.section}>
            <div className={s.label}>
              <span>{pinnedSessionSectionLabel}</span>
              <span className={s.labelNum}>✕✕</span>
            </div>
            {pinned.map((sess) => {
              const running = isSessionRunning(sess, runtimeBySession);
              const state: "live" | "ok" | "err" =
                running
                  ? "live"
                  : sess.end_reason === "error" || sess.end_reason === "interrupted"
                    ? "err"
                    : "ok";
              const ts = sess.ended_at ?? sess.started_at;
              return (
                <SessionRow
                  key={sess.id}
                  session={sess}
                  state={state}
                  active={sessionIdMatches(sess.id, activeSessionId)}
                  meta={running ? `${modelShort(sess.model)} · ${elapsed(sess.started_at, now)}` : relTime(ts, now)}
                  projectName={projectNameBySessionId.get(sess.id)}
                  pinned={pinnedSessionIds.has(sess.id)}
                  menuDisabled={running}
                  actions={rowActions}
                  onClick={() => goSession(sess)}
                  onHover={() => hoverSession(sess)}
                />
              );
            })}
          </section>
        ) : null}

        <section className={s.section}>
          <div className={s.label}>
            <span>{pinnedProjectSectionLabel}</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          {pinnedProjects.length === 0 ? (
            <button
              type="button"
              className={s.sideItem}
              onClick={() => navigate("/projects")}
            >
              <span className={s.sideItemIcon}>
                <Folder size={14} />
              </span>
              <span className={s.sideItemLabel}>暂无置顶项目</span>
            </button>
          ) : (
            pinnedProjects.map((proj) => {
              const target = `/projects/${encodeURIComponent(proj.path)}`;
              return (
                <button
                  type="button"
                  key={proj.path}
                  className={s.sideItem}
                  data-active={location.pathname === target ? "true" : undefined}
                  onClick={() => navigate(target)}
                  title={proj.path}
                >
                  <span className={s.sideItemIcon}>
                    <Folder size={14} />
                  </span>
                  <span className={s.sideItemLabel}>{proj.name}</span>
                </button>
              );
            })
          )}
        </section>

        <section className={s.section}>
          <div className={s.label}>
            <span>{recentSectionLabel}</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          {recent.length === 0 ? (
            <div className={s.empty}>暂无最近会话</div>
          ) : (
            recent.map((sess) => {
              const state: "ok" | "err" =
                sess.end_reason === "error" || sess.end_reason === "interrupted" ? "err" : "ok";
              const meta = relTime(sess.ended_at ?? sess.started_at, now);
              return (
                <SessionRow
                  key={sess.id}
                  session={sess}
                  state={state}
                  active={sessionIdMatches(sess.id, activeSessionId)}
                  meta={meta}
                  projectName={projectNameBySessionId.get(sess.id)}
                  pinned={pinnedSessionIds.has(sess.id)}
                  actions={rowActions}
                  onClick={() => goSession(sess)}
                  onHover={() => hoverSession(sess)}
                />
              );
            })
          )}
        </section>
      </div>

      {rowActions.renamingSession ? (
        <SessionRenameModal
          value={rowActions.renameValue}
          saving={rowActions.renameSaving}
          error={rowActions.renameError}
          onChange={rowActions.setRenameValue}
          onClose={rowActions.closeRename}
          onSubmit={rowActions.submitRename}
        />
      ) : null}

      {rowActions.deleteTargets ? (
        <SessionDeleteModal
          sessions={rowActions.deleteTargets}
          deleting={rowActions.isDeleting}
          onClose={rowActions.closeDeleteDialog}
          onConfirm={rowActions.confirmDelete}
        />
      ) : null}
    </aside>
  );
}
