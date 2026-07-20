import type { ReactNode } from "react";
import { TaskRail } from "./task-rail";
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
      </div>
      <SettingsDialog />
      <AuthDialog />
    </div>
  );
}
