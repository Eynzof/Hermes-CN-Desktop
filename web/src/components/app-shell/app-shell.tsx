import type { ReactNode } from "react";
import { useAtom } from "jotai";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { IconButton } from "@hermes/shared-ui";
import { appSidebarVisibleAtom } from "@/stores/ui";
import { AppTopBar } from "./app-top-bar";
import { AppSidebar } from "./app-sidebar";
import { AppStatusBar } from "./app-status-bar";
import { ConnectionTargetNotice } from "./connection-target-notice";
import { ModelOnboardingDialog } from "./model-onboarding-dialog";
import s from "./app-shell.module.css";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [sidebarVisible, setSidebarVisible] = useAtom(appSidebarVisibleAtom);
  const toggleLabel = sidebarVisible ? "隐藏左侧边栏" : "显示左侧边栏";

  return (
    <div className={s.shell} data-sidebar-visible={sidebarVisible ? "true" : "false"}>
      <div className={s.topbarSlot}>
        <AppTopBar />
      </div>
      <div
        id="app-sidebar"
        className={s.sidebarSlot}
        aria-hidden={sidebarVisible ? undefined : true}
        inert={sidebarVisible ? undefined : true}
      >
        <AppSidebar />
        {sidebarVisible ? (
            <IconButton
              className={s.sidebarToggle}
              variant="outline"
              size="xs"
              aria-label={toggleLabel}
              aria-controls="app-sidebar"
              aria-expanded="true"
              title={toggleLabel}
              onClick={() => setSidebarVisible(false)}
            >
              <PanelLeftClose size={12} />
            </IconButton>
        ) : null}
      </div>
      <div className={s.mainSlot}>
        <ConnectionTargetNotice />
        {children}
        <ModelOnboardingDialog />
      </div>
      <div className={s.statusbarSlot}>
        <AppStatusBar />
      </div>
      <IconButton
        className={s.sidebarRestoreButton}
        data-visible={sidebarVisible ? "false" : "true"}
        variant="outline"
        size="xs"
        aria-label="显示左侧边栏"
        aria-controls="app-sidebar"
        aria-expanded={sidebarVisible ? "true" : "false"}
        aria-hidden={sidebarVisible ? true : undefined}
        disabled={sidebarVisible}
        tabIndex={sidebarVisible ? -1 : 0}
        title="显示左侧边栏"
        onClick={() => setSidebarVisible(true)}
      >
        <PanelLeftOpen size={12} />
      </IconButton>
    </div>
  );
}
