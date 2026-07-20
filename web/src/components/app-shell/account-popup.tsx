import { useState } from "react";
import { useSetAtom } from "jotai";
import { Popover, useTheme } from "@hermes/shared-ui";
import {
  Check,
  ChevronRight,
  Command,
  HelpCircle,
  Palette,
  Power,
  RefreshCw,
  Settings,
  Users,
} from "lucide-react";
import {
  useActiveProfileName,
  useProfiles,
  useSetActiveProfile,
} from "@/hooks/use-profiles";
import { useStatus } from "@/hooks/use-status";
import { useModelInfo } from "@/hooks/use-config";
import { useCommandPalette } from "@/components/command-palette";
import { openSettingsDialogAtom } from "@/stores/settings-dialog";
import { dashboardPortFromUrl, dashboardUrlFromInputs } from "@/lib/dashboard-url";
import { DESKTOP_VERSION, versionLabel } from "@/lib/build-info";
import s from "./account-popup.module.css";

const DESKTOP_VERSION_LABEL = versionLabel(DESKTOP_VERSION);

function isDarkTheme(theme: string): boolean {
  return theme === "dark" || theme === "dark-modern" || theme === "dracula" || theme === "catppuccin-mocha";
}

function modelShort(model: string | null | undefined): string {
  if (!model) return "—";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function AccountPopup() {
  const [open, setOpen] = useState(false);
  const [profileListOpen, setProfileListOpen] = useState(false);
  const activeProfile = useActiveProfileName();
  const profilesQuery = useProfiles();
  const setActiveProfile = useSetActiveProfile();
  const { data: status, isError: statusError } = useStatus();
  const { data: modelInfo } = useModelInfo();
  const { config: themeConfig, update: updateTheme } = useTheme();
  const { openCommandPalette } = useCommandPalette();
  const openSettingsDialog = useSetAtom(openSettingsDialogAtom);

  const dashboardUrl = dashboardUrlFromInputs({
    healthUrl: status?.gateway_health_url,
    runtimeConfig: typeof window === "undefined" ? null : window.__HERMES_RUNTIME__,
    envOrigin: import.meta.env.VITE_HERMES_DASHBOARD_ORIGIN,
  });
  const port = dashboardPortFromUrl(dashboardUrl);
  const gatewayOnline = !!status && !statusError;
  const dark = isDarkTheme(themeConfig.theme);
  const profiles = profilesQuery.data ?? [];

  const avatarLetter = (activeProfile.trim()[0] ?? "H").toUpperCase();
  const statusLine = gatewayOnline
    ? `网关已连接 · 端口 ${port} · ${modelShort(modelInfo?.model)}`
    : "网关未连接";

  const openSettings = (pane: Parameters<typeof openSettingsDialog>[0]) => {
    setOpen(false);
    openSettingsDialog(pane);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={s.account} title="账号与设置">
          <span className={s.avatar} aria-hidden="true">
            {avatarLetter}
          </span>
          <span className={s.accountText}>
            <span className={s.accountName}>{activeProfile}</span>
            <span className={s.accountStatus}>
              <span className={s.statusDot} data-online={gatewayOnline ? "true" : undefined} />
              {gatewayOnline ? "已连接" : "离线"} · {modelShort(modelInfo?.model)}
            </span>
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={s.popup} side="top" align="start" sideOffset={8}>
          <div className={s.head}>
            <span className={s.avatar} data-size="lg" aria-hidden="true">
              {avatarLetter}
            </span>
            <div className={s.headText}>
              <div className={s.headName}>{activeProfile}</div>
              <div className={s.headStatus}>
                <span className={s.statusDot} data-online={gatewayOnline ? "true" : undefined} />
                {statusLine}
              </div>
            </div>
          </div>
          <div className={s.sep} />

          <button type="button" className={s.item} onClick={() => openSettings("system")}>
            <Settings size={14} className={s.itemIcon} />
            <span className={s.grow}>设置</span>
          </button>

          <div className={s.item} role="group" aria-label="外观">
            <Palette size={14} className={s.itemIcon} />
            <span className={s.grow}>外观</span>
            <span className={s.seg}>
              <button
                type="button"
                className={s.segItem}
                data-on={!dark ? "true" : undefined}
                onClick={() => updateTheme({ theme: "light-modern" })}
              >
                浅色
              </button>
              <button
                type="button"
                className={s.segItem}
                data-on={dark ? "true" : undefined}
                onClick={() => updateTheme({ theme: "dark-modern" })}
              >
                深色
              </button>
            </span>
          </div>

          <button
            type="button"
            className={s.item}
            onClick={() => setProfileListOpen((v) => !v)}
            aria-expanded={profileListOpen}
          >
            <Users size={14} className={s.itemIcon} />
            <span className={s.grow}>切换 Profile</span>
            <ChevronRight
              size={13}
              className={s.tailIcon}
              data-open={profileListOpen ? "true" : undefined}
            />
          </button>
          {profileListOpen ? (
            <div className={s.profileList}>
              {profilesQuery.isLoading ? (
                <div className={s.profileEmpty}>加载中…</div>
              ) : profiles.length === 0 ? (
                <div className={s.profileEmpty}>没有可用的 Profile</div>
              ) : (
                profiles.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    className={s.profileItem}
                    data-active={p.name === activeProfile ? "true" : undefined}
                    disabled={setActiveProfile.isPending}
                    onClick={() => {
                      if (p.name !== activeProfile) setActiveProfile.mutate(p.name);
                    }}
                  >
                    <span className={s.grow}>{p.name}</span>
                    {p.name === activeProfile ? <Check size={13} /> : null}
                  </button>
                ))
              )}
            </div>
          ) : null}

          <button
            type="button"
            className={s.item}
            onClick={() => {
              setOpen(false);
              openCommandPalette();
            }}
          >
            <Command size={14} className={s.itemIcon} />
            <span className={s.grow}>命令面板</span>
            <span className={s.tail}>⌘K</span>
          </button>

          <button type="button" className={s.item} onClick={() => openSettings("help")}>
            <HelpCircle size={14} className={s.itemIcon} />
            <span className={s.grow}>帮助与反馈</span>
            <span className={s.tail}>文档 · 调试包 ›</span>
          </button>

          <button type="button" className={s.item} onClick={() => openSettings("help")}>
            <RefreshCw size={14} className={s.itemIcon} />
            <span className={s.grow}>检查更新</span>
            <span className={s.tail} data-tone="ok">
              {DESKTOP_VERSION_LABEL}
            </span>
          </button>

          <div className={s.sep} />

          <button
            type="button"
            className={s.item}
            data-tone="danger"
            onClick={() => window.close()}
          >
            <Power size={14} className={s.itemIcon} />
            <span className={s.grow}>退出</span>
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
