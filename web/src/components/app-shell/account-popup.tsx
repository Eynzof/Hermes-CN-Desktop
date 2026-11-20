import { BRAND } from "@/lib/brand.generated";
import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Popover, useTheme } from "@hermes/shared-ui";
import {
  Check,
  ChevronRight,
  Command,
  HelpCircle,
  LogIn,
  LogOut,
  Palette,
  Power,
  RefreshCw,
  Settings,
  Users,
} from "lucide-react";
import { useActiveProfileName, useProfiles, useSetActiveProfile } from "@/hooks/use-profiles";
import { useStatus } from "@/hooks/use-status";
import { useAccountBalance, useAccountLogout, useAccountStatus } from "@/hooks/use-account";
import { useModelInfo } from "@/hooks/use-config";
import { useCommandPalette } from "@/components/command-palette";
import { openSettingsDialogAtom } from "@/stores/settings-dialog";
import { gwConnectionAtom } from "@/stores/chat";
import {
  authDialogOpenAtom,
  huanxingAuthAtom,
} from "@/stores/auth";
import { huanxingAccountTypeLabel } from "@/lib/huanxing-auth";
import { dashboardPortFromUrl, dashboardUrlFromInputs } from "@/lib/dashboard-url";
import { DESKTOP_VERSION, versionLabel } from "@/lib/build-info";
import { runtime } from "@/lib/runtime";
import { RechargeDialog } from "@/components/account/recharge-dialog";
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
  const huanxingAccount = useAtomValue(huanxingAuthAtom);
  const gatewayConnection = useAtomValue(gwConnectionAtom);
  const setHuanxingAccount = useSetAtom(huanxingAuthAtom);
  const accountLogout = useAccountLogout();
  const { data: accountStatus } = useAccountStatus();
  const ccwork = BRAND.accountBackend === "ccwork";
  const balance = useAccountBalance(ccwork && open && accountStatus?.loggedIn === true);
  const openAuthDialog = useSetAtom(authDialogOpenAtom);
  const [rechargeOpen, setRechargeOpen] = useState(false);

  useEffect(() => {
    const user = accountStatus?.user;
    if (accountStatus && !accountStatus.loggedIn) { if (huanxingAccount) setHuanxingAccount(null); return; }
    if (!user || (huanxingAccount?.userId === user.id && huanxingAccount.username === user.username)) return;
    setHuanxingAccount({
      serverUrl: accountStatus.serverUrl ?? "",
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
    });
  }, [accountStatus, huanxingAccount, setHuanxingAccount]);

  const dashboardUrl = dashboardUrlFromInputs({
    healthUrl: status?.gateway_health_url,
    runtimeConfig: typeof window === "undefined" ? null : window.__HERMES_RUNTIME__,
    envOrigin: import.meta.env.VITE_HERMES_DASHBOARD_ORIGIN,
  });
  const port = dashboardPortFromUrl(dashboardUrl);
  // BackendApp only mounts after the managed runtime gate is ready. During the
  // first status refetch, keep the account strip online instead of flashing a
  // false "offline" state; a live WS connection also wins over a stale REST
  // error after login/reconnect.
  const gatewayOnline = gatewayConnection === "open"
    || Boolean(status)
    || (runtime.isBackendReady() && !statusError);
  const dark = isDarkTheme(themeConfig.theme);
  const profiles = profilesQuery.data ?? [];
  // The lower-left account area is for the Huanxing account, not the active
  // Hermes profile.  The profile atom defaults to `default`, which is an
  // internal runtime name and must not be presented as a username.
  const accountDisplayName = huanxingAccount?.username?.trim() || "登录 / 注册";
  const avatarLetter = (huanxingAccount?.username?.trim()[0] ?? "H").toUpperCase();
  const statusLine = gatewayOnline
    ? `网关已连接 · 端口 ${port} · ${modelShort(modelInfo?.model)}`
    : "网关未连接";

  const openSettings = (pane: Parameters<typeof openSettingsDialog>[0]) => {
    setOpen(false);
    openSettingsDialog(pane);
  };

  const quitApp = () => {
    setOpen(false);
    if (window.hermesDesktop?.quitApp) {
      void window.hermesDesktop.quitApp();
      return;
    }
    window.close();
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={s.account} title="账号与设置">
          <span className={s.avatar} aria-hidden="true">{avatarLetter}</span>
          <span className={s.accountText}>
            <span className={s.accountName}>{accountDisplayName}</span>
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
            <span className={s.avatar} data-size="lg" aria-hidden="true">{avatarLetter}</span>
            <div className={s.headText}>
              <div className={s.headName}>{accountDisplayName}</div>
              <div className={s.headStatus}>
                <span className={s.statusDot} data-online={gatewayOnline ? "true" : undefined} />
                {statusLine}
              </div>
            </div>
          </div>
          <div className={s.sep} />

          {huanxingAccount ? (
            <div className={s.enterpriseCard}>
              <div className={s.enterpriseRow}>
                <span className={s.grow}>
                  <span className={s.enterpriseName}>{huanxingAccount.username}</span>
                  <span className={s.enterpriseMeta}>
                    {ccwork ? "ccwork 账号 · 个人组织" : huanxingAccountTypeLabel(huanxingAccount.type)}
                  </span>
                </span>
                <button
                  type="button"
                  className={s.enterpriseLogout}
                  title="退出账号"
                  onClick={() => {
                    void accountLogout.mutateAsync().catch(() => undefined).finally(() => {
                      setHuanxingAccount(null);
                    });
                  }}
                >
                  <LogOut size={12} />
                  退出登录
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={s.item}
              onClick={() => {
                setOpen(false);
                openAuthDialog(true);
              }}
            >
              <LogIn size={16} className={s.itemIcon} />
              <span className={s.grow}>{ccwork ? "登录 / 注册 ccwork 账号" : "登录 / 注册账号"}</span>
              <span className={s.tail}>账号登录</span>
            </button>
          )}

          {ccwork && accountStatus?.loggedIn && <div className={s.enterpriseCard}>
            <div className={s.enterpriseMeta}>
              {balance.isLoading ? "正在读取 ccwork 钱包…" : balance.isError ? "ccwork 钱包暂时不可用" : balance.data ? <>可用积分 {balance.data.availableCredits} · 冻结积分 {balance.data.frozenCredits}<br />{balance.data.monthlyConsumedCredits != null && balance.data.todayConsumedCredits != null ? <>本月消耗 {balance.data.monthlyConsumedCredits} · 今日消耗 {balance.data.todayConsumedCredits}</> : "本月消耗暂不可用"}</> : null}
            </div>
            <button type="button" className={s.item} onClick={() => setRechargeOpen(true)}>充值代币</button>
          </div>}

          <div className={s.sep} />
          <button type="button" className={s.item} onClick={() => openSettings("system")}>
            <Settings size={16} className={s.itemIcon} />
            <span className={s.grow}>设置</span>
          </button>

          <div className={s.item} role="group" aria-label="外观">
            <Palette size={16} className={s.itemIcon} />
            <span className={s.grow}>外观</span>
            <span className={s.seg}>
              <button type="button" className={s.segItem} data-on={!dark ? "true" : undefined} onClick={() => updateTheme({ theme: "light-modern" })}>浅色</button>
              <button type="button" className={s.segItem} data-on={dark ? "true" : undefined} onClick={() => updateTheme({ theme: "dark-modern" })}>深色</button>
            </span>
          </div>

          <button type="button" className={s.item} onClick={() => setProfileListOpen((value) => !value)} aria-expanded={profileListOpen}>
            <Users size={16} className={s.itemIcon} />
            <span className={s.grow}>切换 Profile</span>
            <ChevronRight size={12} className={s.tailIcon} data-open={profileListOpen ? "true" : undefined} />
          </button>
          {profileListOpen ? (
            <div className={s.profileList}>
              {profilesQuery.isLoading ? (
                <div className={s.profileEmpty}>加载中…</div>
              ) : profiles.length === 0 ? (
                <div className={s.profileEmpty}>没有可用的 Profile</div>
              ) : profiles.map((profile) => (
                <button key={profile.name} type="button" className={s.profileItem} data-active={profile.name === activeProfile ? "true" : undefined} disabled={setActiveProfile.isPending} onClick={() => { if (profile.name !== activeProfile) setActiveProfile.mutate(profile.name); }}>
                  <span className={s.grow}>{profile.name}</span>
                  {profile.name === activeProfile ? <Check size={12} /> : null}
                </button>
              ))}
            </div>
          ) : null}

          <button type="button" className={s.item} onClick={() => { setOpen(false); openCommandPalette(); }}>
            <Command size={16} className={s.itemIcon} />
            <span className={s.grow}>命令面板</span>
            <span className={s.tail}>⌘K</span>
          </button>
          <button type="button" className={s.item} onClick={() => openSettings("help")}>
            <HelpCircle size={16} className={s.itemIcon} />
            <span className={s.grow}>帮助与反馈</span>
            <span className={s.tail}>文档 · 调试包</span>
          </button>
          <button type="button" className={s.item} onClick={() => openSettings("help")}>
            <RefreshCw size={16} className={s.itemIcon} />
            <span className={s.grow}>检查更新</span>
            <span className={s.tail} data-tone="ok">{DESKTOP_VERSION_LABEL}</span>
          </button>
          <div className={s.sep} />
          <button type="button" className={s.item} data-tone="danger" onClick={quitApp}>
            <Power size={16} className={s.itemIcon} />
            <span className={s.grow}>退出</span>
          </button>
        </Popover.Content>
      </Popover.Portal>
      <RechargeDialog open={rechargeOpen} onOpenChange={setRechargeOpen} />
    </Popover.Root>
  );
}
