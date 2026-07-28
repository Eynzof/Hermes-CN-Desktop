import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Boxes,
  Clock,
  Cpu,
  Edit3,
  ExternalLink,
  FileText,
  Folder,
  HeartPulse,
  LayoutDashboard,
  MessageSquare,
  Puzzle,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import { usePlatform } from "@hermes/shared-ui";
import { HermesLogoMark } from "@/components/brand/hermes-logo-mark";
import { useStatus } from "@/hooks/use-status";
import { useModelInfo } from "@/hooks/use-config";
import {
  readWorkspaceProjects,
  subscribeWorkspaceChanges,
  type WorkspaceProject,
} from "@/lib/workspaces";
import { ProfileSelector } from "./profile-selector";
import s from "./sidebar.module.css";

const PROJECT_QUICK_LIMIT = 6;

interface NavGroupProps {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}

function NavGroup({ label, right, children }: NavGroupProps) {
  return (
    <section className={s.group}>
      <div className={s.groupHeader}>
        <span className={s.groupLabel}>{label}</span>
        {right}
      </div>
      <div className={s.groupBody}>{children}</div>
    </section>
  );
}

interface NavItemProps {
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
  active: boolean;
  count?: string;
  onClick: () => void;
  title?: string;
}

function NavItem({ icon: Icon, label, active, count, onClick, title }: NavItemProps) {
  return (
    <button
      type="button"
      className={s.navItem}
      data-active={active ? "true" : undefined}
      onClick={onClick}
      title={title ?? label}
    >
      <Icon size={16} className={s.navIcon} />
      <span className={s.navLabel}>{label}</span>
      {count ? <span className={s.navCount}>{count}</span> : null}
    </button>
  );
}

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const platform = usePlatform();
  const { data: status, isError: statusError } = useStatus();
  const { data: modelInfo } = useModelInfo();
  const [workspaceProjects, setWorkspaceProjects] = useState<WorkspaceProject[]>(
    readWorkspaceProjects,
  );

  useEffect(
    () => subscribeWorkspaceChanges(() => setWorkspaceProjects(readWorkspaceProjects())),
    [],
  );

  const path = location.pathname;
  const matchPath = (target: string) =>
    target === "/" ? path === "/" : path === target || path.startsWith(target + "/");

  const goNew = () => navigate("/");
  const goSearch = () => navigate("/history");

  // CSS 在 sidebar.module.css 里把 data-state="stopped" / "offline"
  // 都画成红点。但 PTY daemon 默认就是 stopped（P-009 后 v2 transport
  // 走进程内 dispatch，不需要 daemon），所以这里把 daemon 的 stopped
  // 状态归到 "ready"，只有 status 拉不到才真的算 offline。详见
  // health-grid.tsx 顶部注释。
  const daemonRunning = status?.gateway_state === "running" || status?.gateway_running;
  const gatewayState = statusError
    ? "offline"
    : status
      ? daemonRunning
        ? "running"
        : "ready"
      : "unknown";
  const gatewayLabel = statusError
    ? "离线"
    : status
      ? daemonRunning
        ? "运行中"
        : "就绪"
      : "连接中";
  const modelLabel = modelInfo?.model ? `默认 ${modelInfo.model}` : "—";

  const sortedProjects = useMemo(
    () => [...workspaceProjects].sort((a, b) => b.updatedAt - a.updatedAt),
    [workspaceProjects],
  );

  const projectActions = (
    <button
      type="button"
      className={s.groupAction}
      onClick={() => navigate("/projects")}
      title="管理项目"
      aria-label="管理项目"
    >
      <ExternalLink size={12} />
    </button>
  );

  return (
    <aside className={s.sidebar}>
      <div
        className={s.trafficLights}
        data-window-drag
        data-tauri-drag-region="deep"
        data-native={platform === "electron" ? "true" : undefined}
      >
        {platform === "web" && (
          <>
            <span className={s.dot} style={{ background: "#ed6a5e" }} />
            <span className={s.dot} style={{ background: "#f5be4f" }} />
            <span className={s.dot} style={{ background: "#62c554" }} />
          </>
        )}
      </div>

      <ProfileSelector />

      <div className={s.topActions}>
        <button
          type="button"
          className={s.topBtn}
          data-active={matchPath("/") ? "true" : undefined}
          onClick={goNew}
        >
          <Edit3 size={16} className={s.navIcon} /> 新对话
        </button>
        <button type="button" className={s.topBtn} onClick={goSearch}>
          <Search size={16} className={s.navIcon} /> 搜索
          <span className={s.kbd}>⌘ K</span>
        </button>
      </div>

      <nav className={s.taskList} aria-label="主导航">
        <NavGroup label="工作">
          <NavItem
            icon={LayoutDashboard}
            label="任务面板"
            active={matchPath("/")}
            onClick={() => navigate("/")}
          />
          <NavItem
            icon={MessageSquare}
            label="对话历史"
            active={matchPath("/history")}
            onClick={() => navigate("/history")}
          />
          <NavItem
            icon={Clock}
            label="定时任务"
            active={matchPath("/cron")}
            onClick={() => navigate("/cron")}
          />
        </NavGroup>

        <NavGroup label="能力">
          <NavItem
            icon={Cpu}
            label="模型"
            active={matchPath("/models")}
            onClick={() => navigate("/models")}
          />
          <NavItem
            icon={Boxes}
            label="档案"
            active={matchPath("/profiles")}
            onClick={() => navigate("/profiles")}
            title="档案：独立 config / .env / sessions / skills 的环境"
          />
          <NavItem
            icon={Sparkles}
            label="技能"
            active={matchPath("/skills")}
            onClick={() => navigate("/skills")}
          />
          <NavItem
            icon={Puzzle}
            label="MCP"
            active={matchPath("/mcp")}
            onClick={() => navigate("/mcp")}
          />
        </NavGroup>

        <NavGroup label="监控">
          <NavItem
            icon={HeartPulse}
            label="健康检查"
            active={matchPath("/health")}
            onClick={() => navigate("/health")}
          />
          <NavItem
            icon={FileText}
            label="日志"
            active={matchPath("/logs")}
            onClick={() => navigate("/logs")}
          />
        </NavGroup>

        <NavGroup label="项目" right={projectActions}>
          {sortedProjects.length === 0 ? (
            <button
              type="button"
              className={s.navItem}
              data-empty="true"
              onClick={() => navigate("/projects")}
            >
              <Folder size={16} className={s.navIcon} />
              <span className={s.navLabel}>暂无项目</span>
            </button>
          ) : (
            sortedProjects.slice(0, PROJECT_QUICK_LIMIT).map((project) => {
              const target = `/projects/${encodeURIComponent(project.path)}`;
              return (
                <NavItem
                  key={project.path}
                  icon={Folder}
                  label={project.name}
                  active={path === target}
                  onClick={() => navigate(target)}
                  title={project.path}
                />
              );
            })
          )}
        </NavGroup>
      </nav>

      <div className={s.brandStrip}>
        <HermesLogoMark className={s.brandMark} size={24} />
        <div className={s.brandText}>
          <div className={s.brandName}>Hermes Agent</div>
          <div className={s.brandSub}>中文社区桌面版</div>
        </div>
      </div>

      <div className={s.statusBar}>
        <div className={s.statusRow}>
          <span className={s.gatewayDot} data-state={gatewayState} />
          <span className={s.statusLabel}>{gatewayLabel}</span>
          <span
            className={s.statusModel}
            title="Dashboard 全局默认模型；新会话若未在 composer 选其他模型则用它"
          >
            {modelLabel}
          </span>
        </div>
      </div>
      <button
        type="button"
        className={s.settingsBtn}
        data-active={matchPath("/settings") ? "true" : undefined}
        onClick={() => navigate("/settings")}
      >
        <Settings size={16} /> 设置
      </button>
    </aside>
  );
}
