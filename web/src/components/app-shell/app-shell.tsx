import type { ReactNode } from "react";
import { TaskRail } from "./task-rail";
import { GuideReminder } from "./guide-reminder";
import { ConnectionTargetNotice } from "./connection-target-notice";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { AuthDialog } from "@/components/auth/auth-dialog";
import s from "./app-shell.module.css";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className={s.shell}>
      <div className={s.railSlot}>
        <TaskRail />
      </div>
      <div className={s.mainSlot}>
        <ConnectionTargetNotice />
        {children}
        <GuideReminder />
      </div>
      <SettingsDialog />
      <AuthDialog />
    </div>
  );
}
