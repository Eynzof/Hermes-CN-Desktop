import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate, useLocation } from "react-router-dom";
import { Folder, MessageSquare, Plus } from "lucide-react";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { activeSessionIdAtom } from "@/stores/ui";
import { useSessions } from "@/hooks/use-sessions";
import { isSessionRunning } from "@/lib/session-activity";
import { sessionDisplayTitle } from "@/lib/session-title";
import {
  readPinnedSessionIds,
  readSessionTitleOverrides,
  subscribeSessionUiStateChanges,
  unpinSessions,
} from "@/lib/session-ui-state";
import { deriveSidebarSessionLists } from "@/lib/sidebar-session-lists";
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

interface SessionRowProps {
  session: SessionSummary;
  state: "live" | "ok" | "err" | "idle";
  active: boolean;
  meta: string;
  projectName?: string;
  onClick: () => void;
}

function SessionRow({ session, state, active, meta, projectName, onClick }: SessionRowProps) {
  const title = sessionDisplayTitle(session);
  return (
    <button
      type="button"
      className={s.sessionRow}
      data-active={active ? "true" : undefined}
      onClick={onClick}
      title={title}
    >
      <div className={s.ttl}>
        <span className={s.dot} data-state={state === "idle" ? undefined : state} />
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
    </button>
  );
}

export function WorkbenchSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const setActiveId = useSetAtom(activeSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const { data } = useSessions();
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
      (data?.sessions ?? []).map((sess) => {
        const override = titleOverrides[sess.id];
        return override ? { ...sess, title: override } : sess;
      }),
    [data?.sessions, titleOverrides],
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

  const activeSessionId = location.pathname.startsWith("/tasks/")
    ? decodeURIComponent(location.pathname.slice("/tasks/".length))
    : null;
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
          data-active={location.pathname.startsWith("/history") ? "true" : undefined}
          onClick={() => navigate("/history")}
        >
          <span className={s.entryIcon}>
            <MessageSquare size={16} />
          </span>
          <span className={s.entryLabel}>对话历史</span>
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
                active={sess.id === activeSessionId}
                meta={`${modelShort(sess.model)} · ${elapsed(sess.started_at, now)}`}
                projectName={projectNameBySessionId.get(sess.id)}
                onClick={() => goSession(sess)}
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
                  active={sess.id === activeSessionId}
                  meta={running ? `${modelShort(sess.model)} · ${elapsed(sess.started_at, now)}` : relTime(ts, now)}
                  projectName={projectNameBySessionId.get(sess.id)}
                  onClick={() => goSession(sess)}
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
                  active={sess.id === activeSessionId}
                  meta={meta}
                  projectName={projectNameBySessionId.get(sess.id)}
                  onClick={() => goSession(sess)}
                />
              );
            })
          )}
        </section>
      </div>
    </aside>
  );
}
