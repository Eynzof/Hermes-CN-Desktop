import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { Popover } from "@hermes/shared-ui";
import {
  Bot,
  Clock3,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pin,
  Plug,
  Plus,
  Puzzle,
  Search,
  X,
} from "lucide-react";
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
} from "@/lib/session-ui-state";
import {
  readSessionWorkspaceMap,
  readWorkspaceProjects,
  subscribeWorkspaceChanges,
  workspaceNameFromPath,
  type WorkspaceProject,
} from "@/lib/workspaces";
import {
  SessionDeleteModal,
  SessionRenameModal,
  SessionRowMenu,
  useSessionRowActions,
} from "@/components/session-actions";
import { AccountPopup } from "./account-popup";
import { DESKTOP_VERSION, versionLabel } from "@/lib/build-info";
import { BRAND } from "@/lib/brand.generated";
import type { SessionSummary } from "@hermes/protocol";
import s from "./task-rail.module.css";

const DESKTOP_VERSION_LABEL = versionLabel(DESKTOP_VERSION);

function relTime(unixSec: number, now: Date) {
  const d = new Date(unixSec * 1000);
  if (d.toDateString() === now.toDateString()) {
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

type TaskStatus = "run" | "done" | "fail";

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  run: "进行中",
  done: "已完成",
  fail: "失败",
};

function taskStatusOf(session: SessionSummary, running: boolean): TaskStatus {
  if (running) return "run";
  if (session.end_reason === "error" || session.end_reason === "interrupted") return "fail";
  return "done";
}

interface NavItem {
  label: string;
  href: string;
  icon: typeof Plus;
  matches: (path: string) => boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { label: "新建任务", href: "/", icon: Plus, matches: (p) => p === "/" || p.startsWith("/new") },
  { label: "助理", href: "/im/feishu", icon: Bot, matches: (p) => p.startsWith("/im") },
  { label: "项目", href: "/projects", icon: Folder, matches: (p) => p.startsWith("/projects") },
  { label: "技能", href: "/skills", icon: Puzzle, matches: (p) => p.startsWith("/skills") },
  { label: "连接器", href: "/mcp", icon: Plug, matches: (p) => p.startsWith("/mcp") },
  { label: "自动化", href: "/cron", icon: Clock3, matches: (p) => p.startsWith("/cron") },
];

interface TaskRowProps {
  session: SessionSummary;
  status: TaskStatus;
  active: boolean;
  meta: string;
  pinned: boolean;
  menuDisabled?: boolean;
  actions: ReturnType<typeof useSessionRowActions>;
  onClick: () => void;
  onHover?: () => void;
}

function TaskRow({
  session,
  status,
  active,
  meta,
  pinned,
  menuDisabled = false,
  actions,
  onClick,
  onHover,
}: TaskRowProps) {
  const title = sessionDisplayTitle(session);
  const actionMenuDisabled = menuDisabled || actions.isDeleting;
  return (
    // role=button (not a real <button>) so the "⋯" trigger can nest inside it.
    <div
      className={s.taskItem}
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
      <div className={s.taskTitle}>
        {status === "run" ? <span className={s.pulseDot} aria-hidden="true" /> : null}
        <span className={s.taskTitleText}>{title}</span>
        {pinned ? <Pin size={11} className={s.pinIcon} aria-label="已置顶" /> : null}
        <span className={s.statusLabel} data-status={status}>
          {TASK_STATUS_LABEL[status]}
        </span>
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
              aria-label="任务操作"
              title={menuDisabled ? "运行中任务暂不可操作" : "任务操作"}
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
      <div className={s.taskMeta}>{meta}</div>
    </div>
  );
}

export function TaskRail() {
  const navigate = useNavigate();
  const location = useLocation();
  const setActiveId = useSetAtom(activeSessionIdAtom);
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
  const [sessionWorkspaceMap, setSessionWorkspaceMap] = useState(readSessionWorkspaceMap);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

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

  const query = searchQuery.trim().toLowerCase();
  const tasks = useMemo(() => {
    const filtered = query
      ? sessions.filter((sess) => sessionDisplayTitle(sess).toLowerCase().includes(query))
      : sessions;
    const weight = (sess: SessionSummary) => {
      if (isSessionRunning(sess, runtimeBySession)) return 0;
      if (pinnedSessionIds.has(sess.id)) return 1;
      return 2;
    };
    return [...filtered].sort((a, b) => {
      const dw = weight(a) - weight(b);
      if (dw !== 0) return dw;
      return (b.ended_at ?? b.started_at) - (a.ended_at ?? a.started_at);
    });
  }, [pinnedSessionIds, query, runtimeBySession, sessions]);

  const workspaceNameBySessionId = useMemo(() => {
    const nameByPath = new Map(projects.map((project) => [project.path, project.name]));
    return new Map(
      Object.entries(sessionWorkspaceMap).flatMap(([sessionId, workspacePath]) => {
        const name = nameByPath.get(workspacePath) ?? workspaceNameFromPath(workspacePath);
        return name ? [[sessionId, name]] : [];
      }),
    );
  }, [projects, sessionWorkspaceMap]);

  const now = new Date();

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

  return (
    <aside className={s.rail}>
      <div className={s.railHead} data-window-drag data-tauri-drag-region="deep">
        <div className={s.brandGroup}>
          <div className={s.brand}>{BRAND.appName}</div>
          <div className={s.ver}>{DESKTOP_VERSION_LABEL}</div>
        </div>
        <span className={s.headIcons}>
          <button
            type="button"
            className={s.headIcon}
            data-active={searchOpen ? "true" : undefined}
            title={searchOpen ? "关闭搜索" : "搜索任务"}
            aria-label={searchOpen ? "关闭搜索" : "搜索任务"}
            data-no-drag
            onClick={() => {
              setSearchOpen((open) => !open);
              if (searchOpen) setSearchQuery("");
            }}
          >
            {searchOpen ? <X size={14} /> : <Search size={14} />}
          </button>
        </span>
      </div>

      <nav className={s.railNav} aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              className={s.navItem}
              data-active={item.matches(location.pathname) ? "true" : undefined}
              onClick={() => navigate(item.href)}
            >
              <span className={s.navIcon}>
                <Icon size={15} />
              </span>
              {item.label}
            </button>
          );
        })}
      </nav>

      {searchOpen ? (
        <div className={s.searchBox}>
          <input
            className={s.searchInput}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索任务标题…"
            autoFocus
          />
        </div>
      ) : null}

      <div className={s.secLabel}>任务 ({tasks.length})</div>
      <div className={s.taskList}>
        {tasks.length === 0 ? (
          <div className={s.empty}>{query ? "没有匹配的任务" : "暂无任务，从「新建任务」开始"}</div>
        ) : (
          tasks.map((sess) => {
            const running = isSessionRunning(sess, runtimeBySession);
            const status = taskStatusOf(sess, running);
            const workspaceName = workspaceNameBySessionId.get(sess.id);
            const time = relTime(sess.ended_at ?? sess.started_at, now);
            const meta = workspaceName ? `${workspaceName} · ${time}` : time;
            return (
              <TaskRow
                key={sess.id}
                session={sess}
                status={status}
                active={sessionIdMatches(sess.id, activeSessionId)}
                meta={meta}
                pinned={pinnedSessionIds.has(sess.id)}
                menuDisabled={running}
                actions={rowActions}
                onClick={() => goSession(sess)}
                onHover={() => hoverSession(sess)}
              />
            );
          })
        )}
      </div>

      <div className={s.secLabel}>空间 ({projects.length})</div>
      <div className={s.spaceList}>
        {projects.length === 0 ? (
          <div className={s.empty}>暂无工作空间</div>
        ) : (
          projects.map((proj) => {
            const target = `/projects/${encodeURIComponent(proj.path)}`;
            return (
              <button
                type="button"
                key={proj.path}
                className={s.spaceItem}
                data-active={location.pathname === target ? "true" : undefined}
                onClick={() => navigate(target)}
                title={proj.path}
              >
                <FolderOpen size={13} className={s.spaceIcon} />
                <span className={s.spaceName}>{proj.name}</span>
              </button>
            );
          })
        )}
      </div>

      <AccountPopup />

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
