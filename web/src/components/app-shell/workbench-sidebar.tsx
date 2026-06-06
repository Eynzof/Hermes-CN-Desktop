import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate, useLocation } from "react-router-dom";
import { Folder, MessageSquare, Plus, Search } from "lucide-react";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { activeSessionIdAtom } from "@/stores/ui";
import { useSessions } from "@/hooks/use-sessions";
import { isSessionRunning } from "@/lib/session-activity";
import { sessionDisplayTitle } from "@/lib/session-title";
import {
  readSessionTitleOverrides,
  subscribeSessionUiStateChanges,
} from "@/lib/session-ui-state";
import {
  readWorkspaceProjects,
  subscribeWorkspaceChanges,
  type WorkspaceProject,
} from "@/lib/workspaces";
import type { SessionSummary } from "@hermes/protocol";
import s from "./workbench-sidebar.module.css";

const PROJECT_QUICK_LIMIT = 6;
const TODAY_LIMIT = 8;

function todayStartSec() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

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

interface SessionRowProps {
  session: SessionSummary;
  state: "live" | "ok" | "err" | "idle";
  active: boolean;
  meta: string;
  onClick: () => void;
}

function SessionRow({ session, state, active, meta, onClick }: SessionRowProps) {
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
      <div className={s.meta}>{meta}</div>
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
  const [projects, setProjects] = useState<WorkspaceProject[]>(readWorkspaceProjects);

  useEffect(() => subscribeSessionUiStateChanges(() => setTitleOverrides(readSessionTitleOverrides())), []);
  useEffect(() => subscribeWorkspaceChanges(() => setProjects(readWorkspaceProjects())), []);

  const sessions = useMemo(
    () =>
      (data?.sessions ?? []).map((sess) => {
        const override = titleOverrides[sess.id];
        return override ? { ...sess, title: override } : sess;
      }),
    [data?.sessions, titleOverrides],
  );

  const now = new Date();
  const todayStart = todayStartSec();

  const { active, today } = useMemo(() => {
    const active: SessionSummary[] = [];
    const today: SessionSummary[] = [];
    for (const sess of sessions) {
      if (isSessionRunning(sess, runtimeBySession)) {
        active.push(sess);
      } else if (sess.ended_at != null && sess.ended_at >= todayStart) {
        today.push(sess);
      }
    }
    today.sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0));
    return { active, today: today.slice(0, TODAY_LIMIT) };
  }, [sessions, runtimeBySession, todayStart]);

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, PROJECT_QUICK_LIMIT),
    [projects],
  );

  const goSession = (sess: SessionSummary) => {
    setActiveId(sess.id);
    navigate(`/tasks/${sess.id}`);
  };

  const activeSessionId = location.pathname.startsWith("/tasks/")
    ? decodeURIComponent(location.pathname.slice("/tasks/".length))
    : null;

  return (
    <aside className={s.sidebar}>
      <button type="button" className={s.newTask} onClick={() => navigate("/")}>
        <span className={s.newTaskLead}>
          <Plus size={14} strokeWidth={2.2} />
          <span>新建对话</span>
        </span>
        <span className={s.newTaskKbd}>⌘ N</span>
      </button>

      <button type="button" className={s.searchRow} onClick={() => navigate("/history")}>
        <span className={s.searchLead}>
          <Search size={13} />
          <span>搜索…</span>
        </span>
        <span className={s.searchKbd}>/</span>
      </button>

      <div className={s.scrollY}>
        <section className={s.section}>
          <div className={s.label}>
            <span>§01 · 工作台</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          <button
            type="button"
            className={s.sideItem}
            data-active={location.pathname.startsWith("/history") ? "true" : undefined}
            onClick={() => navigate("/history")}
          >
            <span className={s.sideItemIcon}>
              <MessageSquare size={14} />
            </span>
            <span className={s.sideItemLabel}>对话历史</span>
          </button>
          <button
            type="button"
            className={s.sideItem}
            data-active={location.pathname.startsWith("/projects") ? "true" : undefined}
            onClick={() => navigate("/projects")}
          >
            <span className={s.sideItemIcon}>
              <Folder size={14} />
            </span>
            <span className={s.sideItemLabel}>工作空间</span>
          </button>
        </section>

        <section className={s.section}>
          <div className={s.label}>
            <span>§02 · 进行中</span>
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
                onClick={() => goSession(sess)}
              />
            ))
          )}
        </section>

        <section className={s.section}>
          <div className={s.label}>
            <span>§03 · 今日</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          {today.length === 0 ? (
            <div className={s.empty}>今日暂无完成</div>
          ) : (
            today.map((sess) => {
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
                  onClick={() => goSession(sess)}
                />
              );
            })
          )}
        </section>

        <section className={s.section}>
          <div className={s.label}>
            <span>§04 · 项目快捷</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          {sortedProjects.length === 0 ? (
            <button
              type="button"
              className={s.sideItem}
              onClick={() => navigate("/projects")}
            >
              <span className={s.sideItemIcon}>
                <Folder size={14} />
              </span>
              <span className={s.sideItemLabel}>暂无项目</span>
            </button>
          ) : (
            sortedProjects.map((proj) => {
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
      </div>
    </aside>
  );
}
