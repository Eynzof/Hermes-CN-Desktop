import { Routes, Route, Navigate, useLocation, useParams } from "react-router-dom";
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
import { OfflineShell } from "@/routes/offline-shell";
import { BootSplash } from "@/components/boot-splash";
import { useBackendGate } from "@/hooks/use-backend-gate";
import {
  normalizeSettingsPane,
  openSettingsDialogAtom,
} from "@/stores/settings-dialog";
import { getTeamDeviceTokenStatus, setTeamDeviceToken } from "@/lib/tauri-bridge";

function NewTaskRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/", search }} replace />;
}

// /settings/<pane> 深链：打开主界面并自动弹出设置弹窗对应面板（兼容旧书签）。
function SettingsDeepLink() {
  const { pane } = useParams();
  const openSettings = useSetAtom(openSettingsDialogAtom);
  useEffect(() => {
    openSettings(normalizeSettingsPane(pane));
  }, [openSettings, pane]);
  return <Navigate to="/" replace />;
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
  useEffect(() => {
    if (window.__TAURI_INTERNALS__ == null) return;
    let cancelled = false;
    void getTeamDeviceTokenStatus().then(async (status) => {
      if (cancelled || status.configured) return;
      const token = window.prompt("请输入企业设备令牌（可留空跳过）", "")?.trim() ?? "";
      if (!token || cancelled) return;
      try {
        const result = await setTeamDeviceToken(token);
        if (!cancelled) window.alert(`企业配置同步完成：${result.syncedModels} 个模型，${result.syncedSkills} 个 skills`);
      } catch (error) {
        if (!cancelled) window.alert(`企业配置同步失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
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
          <Route path="/settings" element={<Navigate to="/settings/system" replace />} />
          <Route path="/settings/:pane" element={<SettingsDeepLink />} />
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
  const gate = useBackendGate();
  useEffect(() => {
    hydrateTheme(readUiValue<Partial<ThemeConfig>>("hermes-theme", DEFAULT_THEME_CONFIG));
  }, [hydrateTheme]);
  useEffect(() => {
    void sendTelemetryPingIfDue();
  }, []);

  let content: ReactNode;
  if (gate === "booting") {
    content = <BootSplash />;
  } else if (gate === "offline") {
    content = <OfflineShell />;
  } else {
    content = <BackendApp />;
  }

  return <div lang="zh-CN" data-hermes-platform={platform}>{content}</div>;
}
