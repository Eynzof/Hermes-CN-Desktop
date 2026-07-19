import type { ReactNode } from "react";
import { AppTopBar } from "./app-top-bar";
import { AppSidebar } from "./app-sidebar";
import { AppStatusBar } from "./app-status-bar";
import { GuideReminder } from "./guide-reminder";
import { ConnectionTargetNotice } from "./connection-target-notice";
import s from "./app-shell.module.css";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className={s.shell}>
      <div className={s.topbarSlot}>
        <AppTopBar />
      </div>
      <div className={s.sidebarSlot}>
        <AppSidebar />
      </div>
      <div className={s.mainSlot}><ConnectionTargetNotice />{children}<GuideReminder /></div>
      <div className={s.statusbarSlot}>
        <AppStatusBar />
      </div>
    </div>
  );
}
