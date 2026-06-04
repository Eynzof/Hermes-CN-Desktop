import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { hydrateThemeAtom, usePlatform } from "@hermes/shared-ui";
import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { useBootstrapActiveProfile } from "@/hooks/use-profiles";
import { readUiValue } from "@/lib/ui-store";
import { ErrorBoundary } from "@/components/error-boundary";
import { ProfileSwitchOverlay } from "@/components/profile-switch-overlay";
import { RuntimeUpdateOverlay } from "@/components/runtime-update-overlay";
import { AppShell } from "@/components/app-shell/app-shell";
import { PanelRoute } from "@/routes/panel";
import { DetailRoute } from "@/routes/detail";
import { HistoryRoute } from "@/routes/history";
import { ProjectsRoute } from "@/routes/projects";
import { ProjectDetailRoute } from "@/routes/project-detail";
import { SkillsRoute } from "@/routes/skills";
import { ModelsRoute } from "@/routes/models";
import { ConfigMigrationRoute } from "@/routes/config-migration";
import { McpRoute } from "@/routes/mcp";
import { ProfilesRoute } from "@/routes/profiles";
import { MemoryRoute } from "@/routes/memory";
import { SoulRoute } from "@/routes/soul";
import { CronRoute } from "@/routes/cron";
import { ConsoleRoute } from "@/routes/console";
import { HealthRoute } from "@/routes/health";
import { LogsRoute } from "@/routes/logs";
import { DebugRoute } from "@/routes/debug";
import { AnalyticsRoute } from "@/routes/analytics";
import { AdvancedRoute } from "@/routes/advanced";
import { ImOnboardingRoute } from "@/routes/im-onboarding";

function NewTaskRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/", search }} replace />;
}

export function App() {
  const platform = usePlatform();
  const hydrateTheme = useSetAtom(hydrateThemeAtom);
  // 首次启动时让 atom 跟上后端 sticky default；UI SQLite 已在 React 挂载前加载，
  // 所以这里只需要做一次种子。
  useBootstrapActiveProfile();
  useEffect(() => {
    hydrateTheme(readUiValue("hermes-theme", { theme: "dark", density: "comfortable" }));
  }, [hydrateTheme]);

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
          <Route path="/config-migration" element={<ConfigMigrationRoute />} />
          <Route path="/mcp" element={<McpRoute />} />
          <Route path="/profiles" element={<ProfilesRoute />} />
          <Route path="/memory" element={<MemoryRoute />} />
          <Route path="/soul" element={<SoulRoute />} />
          <Route path="/cron" element={<CronRoute />} />
          <Route path="/im/*" element={<ErrorBoundary><ImOnboardingRoute /></ErrorBoundary>} />
          <Route path="/console" element={<ConsoleRoute />} />
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
      <RuntimeUpdateOverlay />
    </div>
  );
}
