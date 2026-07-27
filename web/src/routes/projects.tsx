import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DropdownMenu } from "@hermes/shared-ui";
import {
  ExternalLink,
  FolderPlus,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type { SessionSummary } from "@hermes/protocol";
import { useSessions } from "@/hooks/use-sessions";
import { formatTokens, relativeTime } from "@/lib/format";
import { shortenPath } from "@/lib/paths";
import {
  normalizeWorkspacePath,
  readPinnedWorkspaceProjectPaths,
  readSessionWorkspaceMap,
  readWorkspaceProjects,
  rememberWorkspaceProject,
  removeWorkspaceProject,
  subscribeWorkspaceChanges,
  togglePinnedWorkspaceProject,
  type WorkspaceProject,
} from "@/lib/workspaces";
import { runtime } from "@/lib/runtime";
import { TopBar, TopBarActionButton } from "@/components/top-bar/top-bar";
import s from "./projects.module.css";

interface ProjectAggregate {
  project: WorkspaceProject;
  sessions: SessionSummary[];
  weekSessions: number;
  totalTokens: number;
  lastActivity: number; // unix sec
  topModel: string | null;
}

const WEEK_SECONDS = 7 * 24 * 60 * 60;

function lastActivitySec(session: SessionSummary): number {
  return session.ended_at ?? session.started_at;
}

function pickTopModel(sessions: SessionSummary[]): string | null {
  if (sessions.length === 0) return null;
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const model = session.model?.trim();
    if (!model) continue;
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let bestModel: string | null = null;
  let bestCount = 0;
  for (const [model, count] of counts) {
    if (count > bestCount) {
      bestModel = model;
      bestCount = count;
    }
  }
  return bestModel;
}

interface RowMenuProps {
  pinned: boolean;
  desktopAvailable: boolean;
  onTogglePin: () => void;
  onOpenInFinder: () => void;
  onDelete: () => void;
}

function RowMenu({ pinned, desktopAvailable, onTogglePin, onOpenInFinder, onDelete }: RowMenuProps) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        className={s.rowMenu}
        align="end"
        side="bottom"
        sideOffset={4}
        onClick={(event) => event.stopPropagation()}
      >
        <DropdownMenu.Item asChild onSelect={onTogglePin}>
          <button type="button">
            {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            {pinned ? "取消置顶" : "置顶项目"}
          </button>
        </DropdownMenu.Item>
        {desktopAvailable ? (
          <DropdownMenu.Item asChild onSelect={onOpenInFinder}>
            <button type="button">
              <ExternalLink size={13} /> 在 Finder 打开
            </button>
          </DropdownMenu.Item>
        ) : null}
        <DropdownMenu.Item asChild onSelect={onDelete}>
          <button type="button" data-tone="danger">
            <Trash2 size={13} /> 删除项目
          </button>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export function ProjectsRoute() {
  const navigate = useNavigate();
  const { data, isLoading } = useSessions(200, 0);
  const [projects, setProjects] = useState<WorkspaceProject[]>(readWorkspaceProjects);
  const [sessionWorkspaceMap, setSessionWorkspaceMap] = useState(readSessionWorkspaceMap);
  const [pinnedProjectPaths, setPinnedProjectPaths] = useState(readPinnedWorkspaceProjectPaths);
  const [searchQuery, setSearchQuery] = useState("");
  const [openMenuPath, setOpenMenuPath] = useState<string | null>(null);

  useEffect(() => {
    return subscribeWorkspaceChanges(() => {
      setProjects(readWorkspaceProjects());
      setSessionWorkspaceMap(readSessionWorkspaceMap());
      setPinnedProjectPaths(readPinnedWorkspaceProjectPaths());
    });
  }, []);

  const desktopAvailable = typeof window !== "undefined" && !!window.hermesDesktop;

  const aggregates = useMemo<ProjectAggregate[]>(() => {
    const sessions = data?.sessions ?? [];
    const byPath = new Map<string, SessionSummary[]>();
    for (const project of projects) {
      byPath.set(project.path, []);
    }
    for (const session of sessions) {
      const workspace = normalizeWorkspacePath(sessionWorkspaceMap[session.id]);
      if (!workspace) continue;
      const list = byPath.get(workspace);
      if (list) {
        list.push(session);
      }
    }
    const nowSec = Date.now() / 1000;
    return projects.map((project) => {
      const projectSessions = byPath.get(project.path) ?? [];
      let weekSessions = 0;
      let totalTokens = 0;
      let lastActivity = project.updatedAt / 1000;
      for (const session of projectSessions) {
        const activity = lastActivitySec(session);
        if (activity > lastActivity) lastActivity = activity;
        if (session.started_at >= nowSec - WEEK_SECONDS) weekSessions += 1;
        totalTokens += (session.input_tokens ?? 0) + (session.output_tokens ?? 0);
      }
      return {
        project,
        sessions: projectSessions,
        weekSessions,
        totalTokens,
        lastActivity,
        topModel: pickTopModel(projectSessions),
      };
    });
  }, [data?.sessions, projects, sessionWorkspaceMap]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let list = aggregates;
    if (q) {
      list = list.filter(
        (item) =>
          item.project.name.toLowerCase().includes(q) ||
          item.project.path.toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => b.lastActivity - a.lastActivity);
  }, [aggregates, searchQuery]);

  const totalSessionCount = aggregates.reduce((sum, item) => sum + item.sessions.length, 0);

  const handleAddProject = useCallback(async () => {
    try {
      let nextPath = "";
      if (runtime.isRemote()) {
        nextPath = window.prompt("输入远端服务器上的项目绝对路径", "") ?? "";
      } else if (desktopAvailable && window.hermesDesktop?.pickDirectory) {
        const result = await window.hermesDesktop.pickDirectory();
        if (!result.canceled) nextPath = result.paths[0] ?? "";
      } else {
        nextPath = window.prompt("输入项目工作区路径（绝对路径）", "") ?? "";
      }
      const normalized = normalizeWorkspacePath(nextPath);
      if (!normalized) return;
      rememberWorkspaceProject(normalized);
      setProjects(readWorkspaceProjects());
    } catch (error) {
      console.error("Failed to add project:", error);
    }
  }, [desktopAvailable]);

  const handleOpenInFinder = useCallback(async (project: WorkspaceProject) => {
    setOpenMenuPath(null);
    try {
      if (!runtime.isRemote() && window.hermesDesktop?.openWorkspacePath) {
        const result = await window.hermesDesktop.openWorkspacePath({ path: project.path });
        if (!result.ok) console.error("Failed to open project:", result.body);
      }
    } catch (error) {
      console.error("Failed to open project:", error);
    }
  }, []);

  const handleTogglePin = useCallback((project: WorkspaceProject) => {
    setOpenMenuPath(null);
    setPinnedProjectPaths(togglePinnedWorkspaceProject(project.path));
  }, []);

  const handleDelete = useCallback((project: WorkspaceProject) => {
    setOpenMenuPath(null);
    const confirmed = window.confirm(
      `确认删除项目「${project.name}」？该工作区下的会话会被解除关联，但会话本身不会删除。`,
    );
    if (!confirmed) return;
    removeWorkspaceProject(project.path);
    setProjects(readWorkspaceProjects());
    setPinnedProjectPaths(readPinnedWorkspaceProjectPaths());
  }, []);

  const goProject = useCallback(
    (project: WorkspaceProject) => {
      navigate(`/projects/${encodeURIComponent(project.path)}`);
    },
    [navigate],
  );

  return (
    <main className={s.page}>
      <TopBar
        title="项目"
        sub={
          isLoading
            ? "加载中…"
            : `${projects.length} 个项目 · ${totalSessionCount} 个会话`
        }
        right={
          <TopBarActionButton onClick={handleAddProject}>
            <FolderPlus size={13} />
            添加项目
          </TopBarActionButton>
        }
      />

      <div className={s.filters}>
        <div className={s.searchBox}>
          <Search size={13} />
          <input
            type="search"
            placeholder="按名称或路径搜索…"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
        <span className={s.sortHint}>排序 · 最近活动 ↓</span>
      </div>

      <div className={s.scroll}>
        {projects.length === 0 ? (
          <div className={s.emptyState}>
            <FolderPlus size={28} />
            <p>还没有项目</p>
            <p className={s.emptySub}>
              在<a onClick={() => navigate("/")}>新建任务</a>时指定工作区，或者点上方
              <strong> 添加项目 </strong>开始。
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className={s.emptyState}>没有匹配的项目</div>
        ) : (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <colgroup>
                <col className={s.dotCol} />
                <col className={s.projectCol} />
                <col className={s.sessionsCol} />
                <col className={s.activityCol} />
                <col className={s.modelCol} />
                <col className={s.tokensCol} />
                <col className={s.actionsCol} />
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="状态" />
                  <th>项目</th>
                  <th>会话</th>
                  <th>最近活动</th>
                  <th>常用模型</th>
                  <th>累计 Tokens</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => {
                  const { project } = item;
                  const pinned = pinnedProjectPaths.has(project.path);
                  return (
                    <tr
                      key={project.path}
                      onClick={() => goProject(project)}
                      data-active={openMenuPath === project.path ? "true" : undefined}
                    >
                      <td>
                        <span className={s.colorDot} aria-hidden />
                      </td>
                      <td className={s.projectCell} title={`${project.name}\n${project.path}`}>
                        <span className={s.nameLine}>
                          <span className={s.nameCell}>{project.name}</span>
                          {pinned ? <Pin size={12} className={s.titlePin} aria-hidden /> : null}
                        </span>
                        <span className={s.pathCell}>{shortenPath(project.path)}</span>
                      </td>
                      <td className={s.metricCell}>{item.sessions.length}</td>
                      <td className={s.activityCell}>
                        {item.sessions.length === 0 ? "—" : relativeTime(item.lastActivity)}
                      </td>
                      <td className={s.mono}>{item.topModel ?? "—"}</td>
                      <td className={`${s.mono} ${s.metricCell}`}>
                        {formatTokens(item.totalTokens)}
                      </td>
                      <td className={s.menuCell} onClick={(event) => event.stopPropagation()}>
                        <DropdownMenu.Root
                          open={openMenuPath === project.path}
                          onOpenChange={(open) =>
                            setOpenMenuPath(open ? project.path : null)
                          }
                        >
                          <DropdownMenu.Trigger asChild>
                            <button
                              type="button"
                              className={s.menuTrigger}
                              aria-label="项目操作"
                            >
                              <MoreHorizontal size={14} />
                            </button>
                          </DropdownMenu.Trigger>
                          <RowMenu
                            pinned={pinned}
                            desktopAvailable={desktopAvailable}
                            onTogglePin={() => handleTogglePin(project)}
                            onOpenInFinder={() => handleOpenInFinder(project)}
                            onDelete={() => handleDelete(project)}
                          />
                        </DropdownMenu.Root>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={s.foot}>
        <span>
          {filtered.length} / {projects.length} 个项目 ·{" "}
          {formatTokens(aggregates.reduce((sum, item) => sum + item.totalTokens, 0))} tokens
        </span>
        <button type="button" className={s.footAction} onClick={handleAddProject}>
          <Plus size={13} /> 添加项目
        </button>
      </div>
    </main>
  );
}
