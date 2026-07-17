import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { DEFAULT_THEME_CONFIG, hydrateThemeAtom, usePlatform, type ThemeConfig } from "@hermes/shared-ui";
import { useEffect, type ReactNode } from "react";
import { useSetAtom } from "jotai";
import { useBootstrapActiveProfile } from "@/hooks/use-profiles";
import { readUiValue } from "@/lib/ui-store";
import { sendTelemetryPingIfDue } from "@/lib/telemetry";
import { ErrorBoundary } from "@/components/error-boundary";
import { ProfileSwitchOverlay } from "@/components/profile-switch-overlay";
import { RuntimeUpdateOverlay } from "@/components/runtime-update-overlay";
import { DesktopUpdateNotifier } from "@/components/desktop-update-notifier";
import { ConnectionAuthBanner } from "@/components/connection-auth-banner";
import { AppShell } from "@/components/app-shell/app-shell";
import { CommandPalette } from "@/components/command-palette";
import { PanelRoute } from "@/routes/panel";
import { DetailRoute } from "@/routes/detail";
import { HistoryRoute } from "@/routes/history";
import { ProjectsRoute } from "@/routes/projects";
import { ProjectDetailRoute } from "@/routes/project-detail";
import { KanbanRoute } from "@/routes/kanban";
import { SkillsRoute } from "@/routes/skills";
import { ModelsRoute } from "@/routes/models";
import { VoiceRoute } from "@/routes/voice";
import { BackupRoute } from "@/routes/backup";
import { ConfigMigrationRoute } from "@/routes/config-migration";
import { McpRoute } from "@/routes/mcp";
import { ProfilesRoute } from "@/routes/profiles";
import { ProfileBuilderRoute } from "@/routes/profile-builder";
import { MemoryRoute } from "@/routes/memory";
import { SoulRoute } from "@/routes/soul";
import { CronRoute } from "@/routes/cron";
import { ConsoleRoute } from "@/routes/console";
import { HealthRoute } from "@/routes/health";
import { LogsRoute } from "@/routes/logs";
import { DebugRoute } from "@/routes/debug";
import { AnalyticsRoute } from "@/routes/analytics";
import { AdvancedRoute, ThemeRoute } from "@/routes/advanced";
import { CodingAgentsRoute } from "@/routes/coding-agents";
import { ImOnboardingRoute } from "@/routes/im-onboarding";
import { GuideRoute } from "@/routes/guide";
import { OfflineShell } from "@/routes/offline-shell";
import { runtime } from "@/lib/runtime";

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

function BackendApp() {
  useBootstrapActiveProfile();
  return (
    <>
      <AppShell>
        <Routes>
          <Route path="/" element={withBoundary(<PanelRoute />)} />
          <Route path="/new" element={<NewTaskRedirect />} />
          <Route path="/tasks/:taskId" element={withBoundary(<DetailRoute />)} />
          <Route path="/history" element={withBoundary(<HistoryRoute />)} />
          <Route path="/projects" element={withBoundary(<ProjectsRoute />)} />
          <Route path="/projects/:workspacePath" element={withBoundary(<ProjectDetailRoute />)} />
          <Route path="/kanban" element={withBoundary(<KanbanRoute />)} />
          <Route path="/skills" element={withBoundary(<SkillsRoute />)} />
          <Route path="/models" element={withBoundary(<ModelsRoute />)} />
          <Route path="/voice" element={withBoundary(<VoiceRoute />)} />
          <Route path="/backup" element={withBoundary(<BackupRoute />)} />
          <Route path="/config-migration" element={withBoundary(<ConfigMigrationRoute />)} />
          <Route path="/mcp" element={withBoundary(<McpRoute />)} />
          <Route path="/profiles" element={withBoundary(<ProfilesRoute />)} />
          <Route path="/profiles/new" element={withBoundary(<ProfileBuilderRoute />)} />
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
          <Route path="/common" element={withBoundary(<AdvancedRoute />)} />
          <Route path="/notifications" element={withBoundary(<AdvancedRoute />)} />
          <Route path="/config" element={withBoundary(<AdvancedRoute />)} />
          <Route path="/connection" element={withBoundary(<AdvancedRoute />)} />
          <Route path="/kernel" element={withBoundary(<AdvancedRoute />)} />
          <Route path="/env" element={withBoundary(<AdvancedRoute />)} />
          <Route path="/coding-agents" element={withBoundary(<CodingAgentsRoute />)} />
          <Route path="/about" element={withBoundary(<AdvancedRoute />)} />
          <Route path="/advanced/*" element={withBoundary(<AdvancedRoute />)} />
          <Route path="/settings" element={<Navigate to="/common" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
      <ProfileSwitchOverlay />
      <RuntimeUpdateOverlay />
      <DesktopUpdateNotifier />
      <ConnectionAuthBanner />
      <CommandPalette />
    </>
  );
}

export function App() {
  const platform = usePlatform();
  const hydrateTheme = useSetAtom(hydrateThemeAtom);
  const location = useLocation();
  useEffect(() => {
    hydrateTheme(readUiValue<Partial<ThemeConfig>>("hermes-theme", DEFAULT_THEME_CONFIG));
  }, [hydrateTheme]);
  useEffect(() => {
    void sendTelemetryPingIfDue();
  }, []);

  const guideState = runtime.getGuideState();
  const isGuide = location.pathname === "/guide";
  let content: ReactNode;
  if (guideState === "pending" && !isGuide) {
    content = <Navigate to="/guide" replace />;
  } else if (isGuide) {
    content = withBoundary(<GuideRoute />);
  } else if (!runtime.isBackendReady()) {
    content = <OfflineShell />;
  } else {
    content = <BackendApp />;
  }

  return <div lang="zh-CN" data-hermes-platform={platform}>{content}</div>;
}
