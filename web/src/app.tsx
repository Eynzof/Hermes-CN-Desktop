import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { hydrateThemeAtom, usePlatform } from "@hermes/shared-ui";
import { useEffect, type ReactNode } from "react";
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
import { BackupRoute } from "@/routes/backup";
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
import { AdvancedRoute, ThemeRoute } from "@/routes/advanced";
import { ImOnboardingRoute } from "@/routes/im-onboarding";

function NewTaskRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/", search }} replace />;
}

// Wrap each route's content in a local ErrorBoundary so a single page crash
// keeps AppShell (sidebar + nav) usable instead of blanking the whole app via
// the root boundary. Each route element mounts its own boundary, which resets
// naturally on navigation. (#37)
function withBoundary(node: ReactNode) {
  return <ErrorBoundary>{node}</ErrorBoundary>;
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
          <Route path="/" element={withBoundary(<PanelRoute />)} />
          <Route path="/new" element={<NewTaskRedirect />} />
          <Route path="/tasks/:taskId" element={withBoundary(<DetailRoute />)} />
          <Route path="/history" element={withBoundary(<HistoryRoute />)} />
          <Route path="/projects" element={withBoundary(<ProjectsRoute />)} />
          <Route path="/projects/:workspacePath" element={withBoundary(<ProjectDetailRoute />)} />
          <Route path="/skills" element={withBoundary(<SkillsRoute />)} />
          <Route path="/models" element={withBoundary(<ModelsRoute />)} />
          <Route path="/backup" element={withBoundary(<BackupRoute />)} />
          <Route path="/config-migration" element={withBoundary(<ConfigMigrationRoute />)} />
          <Route path="/mcp" element={withBoundary(<McpRoute />)} />
          <Route path="/profiles" element={withBoundary(<ProfilesRoute />)} />
          <Route path="/memory" element={withBoundary(<MemoryRoute />)} />
          <Route path="/soul" element={withBoundary(<SoulRoute />)} />
          <Route path="/cron" element={withBoundary(<CronRoute />)} />
          <Route path="/im/*" element={withBoundary(<ImOnboardingRoute />)} />
          <Route path="/console" element={withBoundary(<ConsoleRoute />)} />
          <Route path="/health" element={withBoundary(<HealthRoute />)} />
          <Route path="/analytics" element={withBoundary(<AnalyticsRoute />)} />
          <Route path="/logs" element={withBoundary(<LogsRoute />)} />
          <Route path="/debug" element={withBoundary(<DebugRoute />)} />
          <Route path="/theme" element={withBoundary(<ThemeRoute />)} />
          <Route path="/advanced/*" element={withBoundary(<AdvancedRoute />)} />
          <Route path="/settings" element={<Navigate to="/advanced" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
      <ProfileSwitchOverlay />
      <RuntimeUpdateOverlay />
    </div>
  );
}
