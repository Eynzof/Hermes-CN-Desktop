import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { DEFAULT_THEME_CONFIG, hydrateThemeAtom, usePlatform, type ThemeConfig } from "@hermes/shared-ui";
import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { useSetAtom } from "jotai";
import { useBootstrapActiveProfile } from "@/hooks/use-profiles";
import { readUiValue } from "@/lib/ui-store";
import { sendTelemetryPingIfDue, sendTokenUsageTelemetryIfDue } from "@/lib/telemetry";
import { ErrorBoundary } from "@/components/error-boundary";
import { ProfileSwitchOverlay } from "@/components/profile-switch-overlay";
import { RuntimeUpdateOverlay } from "@/components/runtime-update-overlay";
import { DesktopUpdateNotifier } from "@/components/desktop-update-notifier";
import { ConnectionAuthBanner } from "@/components/connection-auth-banner";
import { AppShell } from "@/components/app-shell/app-shell";
import { CommandPalette } from "@/components/command-palette";
import { runtime } from "@/lib/runtime";

// ---------------------------------------------------------------------------
// Route-level code splitting.
//
// Every route is loaded with React.lazy() so each page ships as its own chunk
// and is fetched + parsed only when the user actually navigates to it. Before
// this, all ~30 route modules were statically imported here, which pulled the
// whole app (xterm, recharts, katex, mermaid, cmdk, ...) into the startup
// bundle — the production build merged the app into the 3.3 MB mermaid chunk,
// so the first paint had to download and parse ~3.8 MB of JS.
//
// The app shell (sidebar/topbar/statusbar + the overlays below) stays eager:
// it is the chrome that must render immediately. Only route *pages* are
// deferred; on navigation the lazy chunk loads once and is then cached.
// ---------------------------------------------------------------------------
const PanelRoute = lazy(() => import("@/routes/panel").then((m) => ({ default: m.PanelRoute })));
const DetailRoute = lazy(() => import("@/routes/detail").then((m) => ({ default: m.DetailRoute })));
const HistoryRoute = lazy(() => import("@/routes/history").then((m) => ({ default: m.HistoryRoute })));
const ProjectsRoute = lazy(() => import("@/routes/projects").then((m) => ({ default: m.ProjectsRoute })));
const ProjectDetailRoute = lazy(() => import("@/routes/project-detail").then((m) => ({ default: m.ProjectDetailRoute })));
const KanbanRoute = lazy(() => import("@/routes/kanban").then((m) => ({ default: m.KanbanRoute })));
const SkillsRoute = lazy(() => import("@/routes/skills").then((m) => ({ default: m.SkillsRoute })));
const ModelsRoute = lazy(() => import("@/routes/models").then((m) => ({ default: m.ModelsRoute })));
const PortalRoute = lazy(() => import("@/routes/portal").then((m) => ({ default: m.PortalRoute })));
const VoiceRoute = lazy(() => import("@/routes/voice").then((m) => ({ default: m.VoiceRoute })));
const BackupRoute = lazy(() => import("@/routes/backup").then((m) => ({ default: m.BackupRoute })));
const ConfigMigrationRoute = lazy(() => import("@/routes/config-migration").then((m) => ({ default: m.ConfigMigrationRoute })));
const McpRoute = lazy(() => import("@/routes/mcp").then((m) => ({ default: m.McpRoute })));
const ProfilesRoute = lazy(() => import("@/routes/profiles").then((m) => ({ default: m.ProfilesRoute })));
const ProfileBuilderRoute = lazy(() => import("@/routes/profile-builder").then((m) => ({ default: m.ProfileBuilderRoute })));
const MemoryRoute = lazy(() => import("@/routes/memory").then((m) => ({ default: m.MemoryRoute })));
const ExternalMemoryRoute = lazy(() => import("@/routes/external-memory").then((m) => ({ default: m.ExternalMemoryRoute })));
const WanderMemoryMemoriesRoute = lazy(() => import("@/routes/wander-memory/memories").then((m) => ({ default: m.WanderMemoryMemoriesRoute })));
const WanderMemoryFilesRoute = lazy(() => import("@/routes/wander-memory/files").then((m) => ({ default: m.WanderMemoryFilesRoute })));
const WanderMemoryDialogueRoute = lazy(() => import("@/routes/wander-memory/dialogue").then((m) => ({ default: m.WanderMemoryDialogueRoute })));
const WanderMemoryChatRoute = lazy(() => import("@/routes/wander-memory/chat").then((m) => ({ default: m.WanderMemoryChatRoute })));
const WanderMemoryContextRoute = lazy(() => import("@/routes/wander-memory/context").then((m) => ({ default: m.WanderMemoryContextRoute })));
const WanderMemoryStatusRoute = lazy(() => import("@/routes/wander-memory/status").then((m) => ({ default: m.WanderMemoryStatusRoute })));
const WanderMemoryApiDocsRoute = lazy(() => import("@/routes/wander-memory/api-docs").then((m) => ({ default: m.WanderMemoryApiDocsRoute })));
const SoulRoute = lazy(() => import("@/routes/soul").then((m) => ({ default: m.SoulRoute })));
const CronRoute = lazy(() => import("@/routes/cron").then((m) => ({ default: m.CronRoute })));
const ImOnboardingRoute = lazy(() => import("@/routes/im-onboarding").then((m) => ({ default: m.ImOnboardingRoute })));
const ConsoleRoute = lazy(() => import("@/routes/console").then((m) => ({ default: m.ConsoleRoute })));
const HealthRoute = lazy(() => import("@/routes/health").then((m) => ({ default: m.HealthRoute })));
const AnalyticsRoute = lazy(() => import("@/routes/analytics").then((m) => ({ default: m.AnalyticsRoute })));
const LogsRoute = lazy(() => import("@/routes/logs").then((m) => ({ default: m.LogsRoute })));
const DebugRoute = lazy(() => import("@/routes/debug").then((m) => ({ default: m.DebugRoute })));
const ThemeRoute = lazy(() => import("@/routes/advanced").then((m) => ({ default: m.ThemeRoute })));
const AdvancedRoute = lazy(() => import("@/routes/advanced").then((m) => ({ default: m.AdvancedRoute })));
const CodingAgentsRoute = lazy(() => import("@/routes/coding-agents").then((m) => ({ default: m.CodingAgentsRoute })));
const GuideRoute = lazy(() => import("@/routes/guide").then((m) => ({ default: m.GuideRoute })));
const OfflineShell = lazy(() => import("@/routes/offline-shell").then((m) => ({ default: m.OfflineShell })));

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

// Minimal Suspense fallback while a lazy route chunk loads. Kept dependency-
// free on purpose: it must render even before the route chunk (which may carry
// the heavy page libraries) has been fetched and parsed.
function RouteLoadingFallback() {
  return <div className="route-loading" data-route-loading="true" />;
}

function withSuspense(node: ReactNode) {
  return <Suspense fallback={<RouteLoadingFallback />}>{node}</Suspense>;
}

function BackendApp() {
  useBootstrapActiveProfile();
  return (
    <>
      <AppShell>
        <Suspense fallback={<RouteLoadingFallback />}>
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
            <Route path="/portal" element={withBoundary(<PortalRoute />)} />
            <Route path="/voice" element={withBoundary(<VoiceRoute />)} />
            <Route path="/backup" element={withBoundary(<BackupRoute />)} />
            <Route path="/config-migration" element={withBoundary(<ConfigMigrationRoute />)} />
            <Route path="/mcp" element={withBoundary(<McpRoute />)} />
            <Route path="/profiles" element={withBoundary(<ProfilesRoute />)} />
            <Route path="/profiles/new" element={withBoundary(<ProfileBuilderRoute />)} />
            <Route path="/memory" element={withBoundary(<MemoryRoute />)} />
            <Route path="/memconfig" element={withBoundary(<ExternalMemoryRoute page="config" />)} />
            <Route path="/openviking" element={withBoundary(<ExternalMemoryRoute page="openviking" />)} />
            <Route path="/hindsight" element={withBoundary(<ExternalMemoryRoute page="hindsight" />)} />
            <Route path="/wander-memory" element={<Navigate to="/wander-memory/memories" replace />} />
            <Route path="/wander-memory/memories" element={withBoundary(<WanderMemoryMemoriesRoute />)} />
            <Route path="/wander-memory/files" element={withBoundary(<WanderMemoryFilesRoute />)} />
            <Route path="/wander-memory/dialogue" element={withBoundary(<WanderMemoryDialogueRoute />)} />
            <Route path="/wander-memory/chat" element={withBoundary(<WanderMemoryChatRoute />)} />
            <Route path="/wander-memory/context" element={withBoundary(<WanderMemoryContextRoute />)} />
            <Route path="/wander-memory/status" element={withBoundary(<WanderMemoryStatusRoute />)} />
            <Route path="/wander-memory/api" element={withBoundary(<WanderMemoryApiDocsRoute />)} />
            <Route path="/wander-memory/*" element={<Navigate to="/wander-memory/memories" replace />} />
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
        </Suspense>
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
    if (runtime.isBackendReady()) void sendTokenUsageTelemetryIfDue();
  }, []);

  const isGuide = location.pathname === "/guide";
  let content: ReactNode;
  if (isGuide) {
    content = withSuspense(withBoundary(<GuideRoute />));
  } else if (!runtime.isBackendReady()) {
    content = withSuspense(<OfflineShell />);
  } else {
    content = <BackendApp />;
  }

  return <div lang="zh-CN" data-hermes-platform={platform}>{content}</div>;
}
