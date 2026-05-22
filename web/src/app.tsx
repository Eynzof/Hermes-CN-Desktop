import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { usePlatform } from "@hermes/shared-ui";
import { useBootstrapActiveProfile } from "@/hooks/use-profiles";
import { ErrorBoundary } from "@/components/error-boundary";
import { ProfileSwitchOverlay } from "@/components/profile-switch-overlay";
import { AppShell } from "@/components/app-shell/app-shell";
import { PanelRoute } from "@/routes/panel";
import { DetailRoute } from "@/routes/detail";
import { HistoryRoute } from "@/routes/history";
import { ProjectsRoute } from "@/routes/projects";
import { ProjectDetailRoute } from "@/routes/project-detail";
import { SkillsRoute } from "@/routes/skills";
import { ModelsRoute } from "@/routes/models";
import { McpRoute } from "@/routes/mcp";
import { ProfilesRoute } from "@/routes/profiles";
import { MemoryRoute } from "@/routes/memory";
import { CronRoute } from "@/routes/cron";
import { HealthRoute } from "@/routes/health";
import { LogsRoute } from "@/routes/logs";
import { DebugRoute } from "@/routes/debug";
import { AnalyticsRoute } from "@/routes/analytics";
import { AdvancedRoute } from "@/routes/advanced";

function NewTaskRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/", search }} replace />;
}

export function App() {
  const platform = usePlatform();
  // 首次启动时让 atom 跟上后端 sticky default（多 tab 之间 atomWithStorage
  // 自动同步，所以这里只需要做一次种子）
  useBootstrapActiveProfile();

  return (
    <div lang="zh-CN" data-hermes-platform={platform}>
      <AppShell>
        <Routes>
          <Route path="/" element={<PanelRoute />} />
          <Route path="/new" element={<NewTaskRedirect />} />
          <Route path="/tasks/:taskId" element={<ErrorBoundary><DetailRoute /></ErrorBoundary>} />
          <Route path="/history" element={<HistoryRoute />} />
          <Route path="/projects" element={<ProjectsRoute />} />
          <Route path="/projects/:workspacePath" element={<ProjectDetailRoute />} />
          <Route path="/skills" element={<SkillsRoute />} />
          <Route path="/models" element={<ModelsRoute />} />
          <Route path="/mcp" element={<McpRoute />} />
          <Route path="/profiles" element={<ProfilesRoute />} />
          <Route path="/memory" element={<MemoryRoute />} />
          <Route path="/cron" element={<CronRoute />} />
          <Route path="/health" element={<HealthRoute />} />
          <Route path="/analytics" element={<AnalyticsRoute />} />
          <Route path="/logs" element={<LogsRoute />} />
          <Route path="/debug" element={<DebugRoute />} />
          <Route path="/advanced/*" element={<ErrorBoundary><AdvancedRoute /></ErrorBoundary>} />
          <Route path="/settings" element={<Navigate to="/advanced" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
      <ProfileSwitchOverlay />
    </div>
  );
}
