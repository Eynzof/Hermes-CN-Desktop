import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Popover } from "@hermes/shared-ui";
import {
  ChevronLeft,
  ExternalLink,
  Folder,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import type { SessionSummary } from "@hermes/protocol";
import { useSessions } from "@/hooks/use-sessions";
import { sessionDisplayTitle } from "@/lib/session-title";
import { formatTokens, relativeTime } from "@/lib/format";
import { shortenPath } from "@/lib/paths";
import { getSourceMeta } from "@/lib/source-meta";
import {
  normalizeWorkspacePath,
  readSessionWorkspaceMap,
  readWorkspaceProjects,
  removeWorkspaceProject,
  subscribeWorkspaceChanges,
  type WorkspaceProject,
} from "@/lib/workspaces";
import { TopBar, TopBarActionButton } from "@/components/top-bar/top-bar";
import s from "./project-detail.module.css";

const WEEK_SECONDS = 7 * 24 * 60 * 60;

function lastActivitySec(session: SessionSummary): number {
  return session.ended_at ?? session.started_at;
}

function shortId(id: string): string {
  return id.slice(-6);
}

function formatTimestampDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

interface MenuProps {
  desktopAvailable: boolean;
  onOpenInFinder: () => void;
  onDelete: () => void;
}

function ProjectMenu({ desktopAvailable, onOpenInFinder, onDelete }: MenuProps) {
  return (
    <Popover.Portal>
      <Popover.Content
        className={s.menu}
        align="end"
        side="bottom"
        sideOffset={4}
        role="menu"
        onClick={(event) => event.stopPropagation()}
      >
        {desktopAvailable ? (
          <Popover.Close asChild>
            <button type="button" onClick={onOpenInFinder} role="menuitem">
              <ExternalLink size={13} /> 在 Finder 打开
            </button>
          </Popover.Close>
        ) : null}
        <Popover.Close asChild>
          <button type="button" onClick={onDelete} role="menuitem" data-tone="danger">
            <Trash2 size={13} /> 删除项目
          </button>
        </Popover.Close>
      </Popover.Content>
    </Popover.Portal>
  );
}

export function ProjectDetailRoute() {
  const navigate = useNavigate();
  const params = useParams<{ workspacePath: string }>();
  const workspacePath = useMemo(
    () => normalizeWorkspacePath(decodeURIComponent(params.workspacePath ?? "")),
    [params.workspacePath],
  );
  const { data, isLoading } = useSessions(200, 0);
  const [projects, setProjects] = useState<WorkspaceProject[]>(readWorkspaceProjects);
  const [sessionWorkspaceMap, setSessionWorkspaceMap] = useState(readSessionWorkspaceMap);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    return subscribeWorkspaceChanges(() => {
      setProjects(readWorkspaceProjects());
      setSessionWorkspaceMap(readSessionWorkspaceMap());
    });
  }, []);

  const project = useMemo(
    () => projects.find((p) => p.path === workspacePath) ?? null,
    [projects, workspacePath],
  );

  const projectSessions = useMemo<SessionSummary[]>(() => {
    if (!workspacePath) return [];
    const all = data?.sessions ?? [];
    const matched: SessionSummary[] = [];
    for (const session of all) {
      if (normalizeWorkspacePath(sessionWorkspaceMap[session.id]) === workspacePath) {
        matched.push(session);
      }
    }
    return matched.sort((a, b) => lastActivitySec(b) - lastActivitySec(a));
  }, [data?.sessions, sessionWorkspaceMap, workspacePath]);

  const stats = useMemo(() => {
    const nowSec = Date.now() / 1000;
    let weekSessions = 0;
    let weekTokens = 0;
    let totalTokens = 0;
    for (const session of projectSessions) {
      const sessionTokens = (session.input_tokens ?? 0) + (session.output_tokens ?? 0);
      totalTokens += sessionTokens;
      if (session.started_at >= nowSec - WEEK_SECONDS) {
        weekSessions += 1;
        weekTokens += sessionTokens;
      }
    }
    return {
      totalSessions: projectSessions.length,
      weekSessions,
      weekTokens,
      totalTokens,
    };
  }, [projectSessions]);

  const desktopAvailable = typeof window !== "undefined" && !!window.hermesDesktop;

  const goNewTask = useCallback(() => {
    if (!workspacePath) return;
    navigate(`/?workspace=${encodeURIComponent(workspacePath)}`);
  }, [navigate, workspacePath]);

  const handleOpenInFinder = useCallback(async () => {
    setMenuOpen(false);
    if (!project) return;
    try {
      if (window.hermesDesktop?.openWorkspacePath) {
        const result = await window.hermesDesktop.openWorkspacePath({ path: project.path });
        if (!result.ok) console.error("Failed to open project:", result.body);
      }
    } catch (error) {
      console.error("Failed to open project:", error);
    }
  }, [project]);

  const handleDelete = useCallback(() => {
    setMenuOpen(false);
    if (!project) return;
    const confirmed = window.confirm(
      `确认删除项目「${project.name}」？该工作区下的会话会被解除关联，但会话本身不会删除。`,
    );
    if (!confirmed) return;
    removeWorkspaceProject(project.path);
    navigate("/projects");
  }, [navigate, project]);

  if (!workspacePath) {
    return (
      <main className={s.page}>
        <TopBar title="项目详情" sub="缺少项目路径" />
        <div className={s.errorState}>
          <p>URL 没有指定项目路径。</p>
          <button type="button" className={s.linkBack} onClick={() => navigate("/projects")}>
            返回项目列表
          </button>
        </div>
      </main>
    );
  }

  if (!project) {
    return (
      <main className={s.page}>
        <TopBar
          title="项目详情"
          sub={shortenPath(workspacePath)}
          right={
            <TopBarActionButton onClick={() => navigate("/projects")}>
              <ChevronLeft size={13} />
              返回项目
            </TopBarActionButton>
          }
        />
        <div className={s.errorState}>
          <p>找不到这个项目（可能已删除或还未添加）。</p>
          <button type="button" className={s.linkBack} onClick={() => navigate("/projects")}>
            返回项目列表
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className={s.page}>
      <TopBar
        title={
          <span className={s.crumb}>
            <button
              type="button"
              className={s.crumbLink}
              onClick={() => navigate("/projects")}
            >
              项目
            </button>
            <span className={s.crumbSep}>/</span>
            <span className={s.crumbCurrent}>{project.name}</span>
          </span>
        }
        sub={shortenPath(project.path)}
        right={
          <>
            <TopBarActionButton onClick={goNewTask}>
              <Plus size={13} />
              新对话
            </TopBarActionButton>
            <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <Popover.Trigger asChild>
                <TopBarActionButton aria-label="项目操作">
                  <MoreHorizontal size={14} />
                </TopBarActionButton>
              </Popover.Trigger>
              <ProjectMenu
                desktopAvailable={desktopAvailable}
                onOpenInFinder={handleOpenInFinder}
                onDelete={handleDelete}
              />
            </Popover.Root>
          </>
        }
      />

      <div className={s.scroll}>
        <section className={s.hero}>
          <div className={s.heroLeft}>
            <span className={s.iconBox} aria-hidden>
              <Folder size={22} />
            </span>
            <div className={s.heroMeta}>
              <h1>{project.name}</h1>
              <div className={s.heroPath}>{project.path}</div>
              <div className={s.heroDates}>
                创建于 {formatTimestampDate(project.createdAt / 1000)} · 更新于{" "}
                {formatTimestampDate(project.updatedAt / 1000)}
              </div>
            </div>
          </div>
        </section>

        <section className={s.statGrid}>
          <div className={s.statCard}>
            <div className={s.statLabel}>累计会话</div>
            <div className={s.statValue}>{stats.totalSessions}</div>
            <div className={s.statSub}>本周 {stats.weekSessions}</div>
          </div>
          <div className={s.statCard}>
            <div className={s.statLabel}>本周 Tokens</div>
            <div className={s.statValue}>{formatTokens(stats.weekTokens)}</div>
            <div className={s.statSub}>累计 {formatTokens(stats.totalTokens)}</div>
          </div>
          <div className={s.statCard}>
            <div className={s.statLabel}>累计 Tokens</div>
            <div className={s.statValue}>{formatTokens(stats.totalTokens)}</div>
            <div className={s.statSub}>
              {stats.totalSessions > 0
                ? `平均 ${formatTokens(stats.totalTokens / stats.totalSessions)} / 会话`
                : "—"}
            </div>
          </div>
          <div className={s.statCard}>
            <div className={s.statLabel}>最近活动</div>
            <div className={s.statValue}>
              {projectSessions.length > 0
                ? relativeTime(lastActivitySec(projectSessions[0]))
                : "—"}
            </div>
            <div className={s.statSub}>
              {projectSessions.length > 0
                ? sessionDisplayTitle(projectSessions[0])
                : "暂无会话"}
            </div>
          </div>
        </section>

        <section className={s.sec}>
          <div className={s.secHead}>
            <h2>最近会话</h2>
            {projectSessions.length > 0 ? (
              <span className={s.secMeta}>{projectSessions.length} 个</span>
            ) : null}
          </div>
          {isLoading ? (
            <div className={s.emptyHint}>加载会话中…</div>
          ) : projectSessions.length === 0 ? (
            <div className={s.emptyHint}>这个项目下还没有会话。点上方「新对话」开始。</div>
          ) : (
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th style={{ width: 64 }}>ID</th>
                    <th>标题</th>
                    <th style={{ width: 80 }}>来源</th>
                    <th style={{ width: 140 }}>模型</th>
                    <th style={{ width: 110 }}>更新</th>
                    <th style={{ width: 90 }} className={s.numeric}>Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {projectSessions.slice(0, 50).map((session) => {
                    const meta = getSourceMeta(session.source);
                    return (
                      <tr
                        key={session.id}
                        onClick={() => navigate(`/tasks/${session.id}`)}
                      >
                        <td className={s.cellId}>{shortId(session.id)}</td>
                        <td className={s.titleCell}>{sessionDisplayTitle(session)}</td>
                        <td>
                          <span className={s.sourceChip} data-tone={meta.tone}>
                            {meta.label}
                          </span>
                        </td>
                        <td className={s.mono}>{session.model || "—"}</td>
                        <td className={s.cellTimestamp}>
                          {relativeTime(lastActivitySec(session))}
                        </td>
                        <td className={`${s.mono} ${s.numeric}`}>
                          {formatTokens((session.input_tokens ?? 0) + (session.output_tokens ?? 0))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {projectSessions.length > 50 ? (
                <div className={s.tableFoot}>
                  仅展示前 50 条 · 共 {projectSessions.length} 条 ·{" "}
                  <button
                    type="button"
                    className={s.linkBtn}
                    onClick={() =>
                      navigate(`/history?workspace=${encodeURIComponent(project.path)}`)
                    }
                  >
                    在对话历史中查看 →
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
