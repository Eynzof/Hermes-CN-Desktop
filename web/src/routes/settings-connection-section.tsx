// Settings → 连接: choose between the desktop-managed runtime, a loopback
// Hermes Agent CLI dashboard, and a remote Hermes Agent. 本地连接自动从
// dashboard HTML 读取 session token；远程连接继续使用手动 session token。
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Cable,
  CheckCircle2,
  Globe2,
  HardDrive,
  Loader2,
  XCircle,
} from "lucide-react";
import type {
  AuthIdentity,
  AuthProviderInfo,
  ConnectionConfigView,
  ConnectionMode,
  TestConnectionResult,
} from "@hermes/protocol";
import { Alert, Button, Input } from "@hermes/shared-ui";
import { notifyConnectionAuthRestored } from "@/lib/connection-auth-events";
import { SettingsHero } from "./settings-hero";
import { ManagedRuntimePanel } from "./managed-runtime-panel";
import s from "./settings.module.css";

interface SettingsSectionProps {
  showHeading?: boolean;
}

type ProbeStatus = "idle" | "probing" | "reachable" | "unreachable" | "authRequired";
type ConnectionMessage = { tone: "ok" | "error"; text: string; hint?: string };

const PROBE_DEBOUNCE_MS = 500;
const DEFAULT_LOCAL_URL = "http://127.0.0.1:9119";
const LOCAL_DASHBOARD_RECOVERY_HINT =
  "如果确认本机已安装 Hermes，请先运行 hermes dashboard 启动后端，确认 http://127.0.0.1:9119/ 能在浏览器打开，再试一次。";

function modeLabel(mode: ConnectionMode | undefined): string {
  if (mode === "remote") return "外部 Hermes · 远端服务器";
  if (mode === "local") return "外部 Hermes · 本机其他实例";
  return "内置内核";
}

function ModeCard({
  active,
  current,
  icon: Icon,
  title,
  description,
  disabled,
  onSelect,
}: {
  active: boolean;
  current: boolean;
  icon: typeof Globe2;
  title: string;
  description: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={s.approvalModeOption}
      data-active={active ? "true" : undefined}
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className={s.approvalModeOptionTitle}>
        <Icon size={14} aria-hidden="true" />
        {title}
        {current && <span className={s.approvalModeBadge}>当前连接</span>}
        {active && <CheckCircle2 size={14} style={{ marginLeft: "auto" }} aria-hidden="true" />}
      </span>
      <span className={s.approvalModeOptionDesc}>{description}</span>
    </button>
  );
}

function testResultSummary(result: TestConnectionResult): ConnectionMessage {
  if (result.ok) {
    const version = result.version ? ` · Hermes ${result.version}` : "";
    return { tone: "ok", text: `连接正常（${result.baseUrl}${version}）` };
  }
  const detail = result.error ?? "连接失败";
  const parts = [
    `接口 ${result.httpOk ? "✓" : `✗${result.httpStatus ? ` (${result.httpStatus})` : ""}`}`,
    `实时连接 ${result.wsOk ? "✓" : "✗"}`,
  ];
  return { tone: "error", text: `${detail}　[${parts.join("，")}]` };
}

function withLocalDashboardHint(message: ConnectionMessage, mode: ConnectionMode): ConnectionMessage {
  if (mode !== "local" || message.tone !== "error") return message;
  return { ...message, hint: LOCAL_DASHBOARD_RECOVERY_HINT };
}

export function ConnectionSection({ showHeading = true }: SettingsSectionProps) {
  const desktop = typeof window !== "undefined" ? window.hermesDesktop : undefined;
  const supported = Boolean(desktop?.getConnectionConfig);

  const [config, setConfig] = useState<ConnectionConfigView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<ConnectionMode>("managed");
  const [externalKind, setExternalKind] = useState<Exclude<ConnectionMode, "managed">>("local");
  const [localUrl, setLocalUrl] = useState(DEFAULT_LOCAL_URL);
  const [remoteUrl, setRemoteUrl] = useState("");
  // The saved token never round-trips; this holds only what the user types.
  const [tokenInput, setTokenInput] = useState("");
  const [probeStatus, setProbeStatus] = useState<ProbeStatus>("idle");
  const probeSeq = useRef(0);
  // OAuth gate state (populated when a remote probe reports auth_required).
  const [authProviders, setAuthProviders] = useState<AuthProviderInfo[]>([]);
  const [identity, setIdentity] = useState<AuthIdentity | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [pwUser, setPwUser] = useState("");
  const [pwPass, setPwPass] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);

  useEffect(() => {
    if (!desktop?.getConnectionConfig) return;
    desktop
      .getConnectionConfig()
      .then((view) => {
        setConfig(view);
        setMode(view.mode);
        if (view.mode !== "managed") setExternalKind(view.mode);
        setLocalUrl(view.localUrl || DEFAULT_LOCAL_URL);
        setRemoteUrl(view.remoteUrl);
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, [desktop]);

  const envOverride = config?.envOverride ?? false;
  const busy = saving || applying;
  const disabled = !supported || envOverride || busy;
  const trimmedLocalUrl = localUrl.trim() || DEFAULT_LOCAL_URL;
  const trimmedRemoteUrl = remoteUrl.trim();
  const effectiveMode = config?.effectiveMode ?? "managed";

  // Debounced as-you-type reachability probe for remote URLs, sequence-guarded
  // so a slow response for an old URL can't overwrite the current status.
  useEffect(() => {
    if (mode !== "remote" || envOverride || !/^https?:\/\//i.test(trimmedRemoteUrl)) {
      setProbeStatus("idle");
      return;
    }
    const seq = ++probeSeq.current;
    setProbeStatus("probing");
    const timer = window.setTimeout(() => {
      desktop
        ?.probeConnectionConfig?.(trimmedRemoteUrl)
        .then((result) => {
          if (seq !== probeSeq.current) return;
          if (!result.reachable) setProbeStatus("unreachable");
          else if (result.authRequired) {
            setProbeStatus("authRequired");
            setAuthProviders(result.authProviders ?? []);
          } else {
            setProbeStatus("reachable");
            setAuthProviders([]);
          }
        })
        .catch(() => {
          if (seq !== probeSeq.current) return;
          setProbeStatus("unreachable");
        });
    }, PROBE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, trimmedRemoteUrl, envOverride]);

  // A remote that enforces a login gate uses OAuth/cookie auth, not a token.
  const gated = mode === "remote" && probeStatus === "authRequired";

  // When the URL changes, drop any shown identity (it belonged to the old
  // gateway); if the new gateway is gated and we have a saved session, restore.
  useEffect(() => {
    setIdentity(null);
    if (mode !== "remote" || !gated || !/^https?:\/\//i.test(trimmedRemoteUrl)) return;
    let cancelled = false;
    desktop
      ?.connectionAuthMe?.(trimmedRemoteUrl)
      .then((r) => {
        if (!cancelled && r.ok && r.identity) setIdentity(r.identity);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gated, trimmedRemoteUrl]);

  const handleOauthLogin = async (): Promise<void> => {
    if (!desktop?.connectionOauthLogin) return;
    setLoggingIn(true);
    setMessage(null);
    try {
      const r = await desktop.connectionOauthLogin(trimmedRemoteUrl);
      if (r.ok) {
        setIdentity(r.identity ?? null);
        setMessage({ tone: "ok", text: "登录成功" });
        notifyConnectionAuthRestored();
      } else {
        setMessage({ tone: "error", text: r.error ?? "登录失败" });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoggingIn(false);
    }
  };

  const handlePasswordLogin = async (provider: string): Promise<void> => {
    if (!desktop?.connectionPasswordLogin) return;
    setLoggingIn(true);
    setMessage(null);
    try {
      const r = await desktop.connectionPasswordLogin({
        remoteUrl: trimmedRemoteUrl,
        provider,
        username: pwUser,
        password: pwPass,
      });
      if (r.ok) {
        setIdentity(r.identity ?? null);
        setPwPass("");
        setMessage({ tone: "ok", text: "登录成功" });
        notifyConnectionAuthRestored();
      } else {
        setMessage({ tone: "error", text: r.error ?? "登录失败" });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async (): Promise<void> => {
    if (!desktop?.connectionOauthLogout) return;
    try {
      await desktop.connectionOauthLogout(trimmedRemoteUrl);
    } catch {}
    setIdentity(null);
    setMessage({ tone: "ok", text: "已注销" });
  };

  const remoteReady = gated
    ? Boolean(identity) // oauth: must be logged in
    : Boolean(trimmedRemoteUrl && (tokenInput.trim() || config?.remoteTokenSet));
  const localReady = Boolean(trimmedLocalUrl);
  const canSubmit = mode === "managed" || (mode === "local" ? localReady : remoteReady);
  const identityLabel = identity
    ? identity.displayName || identity.email || identity.userId || "已登录"
    : null;

  const handleTest = async () => {
    if (!desktop?.testConnectionConfig || mode === "managed") return;
    setMessage(null);
    setTesting(true);
    try {
      const result = await desktop.testConnectionConfig({
        mode,
        localUrl: mode === "local" ? trimmedLocalUrl : undefined,
        remoteUrl: mode === "remote" ? trimmedRemoteUrl : undefined,
        remoteToken: mode === "remote" && !gated ? tokenInput || undefined : undefined,
        remoteAuthMode: mode === "remote" ? (gated ? "oauth" : "token") : undefined,
      });
      setMessage(withLocalDashboardHint(testResultSummary(result), mode));
    } catch (error) {
      setMessage(withLocalDashboardHint({ tone: "error", text: error instanceof Error ? error.message : String(error) }, mode));
    } finally {
      setTesting(false);
    }
  };

  const submit = async (apply: boolean) => {
    if (!canSubmit) {
      setMessage({
        tone: "error",
        text: mode === "remote" ? "请先填写远程地址和会话令牌" : "请先填写本地连接地址",
      });
      return;
    }
    setMessage(null);
    const setBusy = apply ? setApplying : setSaving;
    setBusy(true);
    try {
      const payload = {
        mode,
        localUrl: mode === "local" ? trimmedLocalUrl : undefined,
        remoteUrl: mode === "remote" ? trimmedRemoteUrl : undefined,
        remoteToken: mode === "remote" && !gated ? tokenInput || undefined : undefined,
        remoteAuthMode: mode === "remote" ? (gated ? ("oauth" as const) : ("token" as const)) : undefined,
      };
      if (apply) {
        const result = await desktop!.applyConnectionConfig!(payload);
        if (result.ok) {
          setMessage({ tone: "ok", text: "已切换，正在重新加载界面…" });
          window.setTimeout(() => window.location.reload(), 600);
          return;
        }
        setMessage(withLocalDashboardHint({ tone: "error", text: result.error ?? "切换失败" }, mode));
      } else {
        const view = await desktop!.saveConnectionConfig!(payload);
        setConfig(view);
        setTokenInput("");
        setMessage({ tone: "ok", text: "已保存，下次启动桌面端时生效" });
      }
    } catch (error) {
      setMessage(withLocalDashboardHint({ tone: "error", text: error instanceof Error ? error.message : String(error) }, mode));
    } finally {
      setBusy(false);
    }
  };

  if (!supported) {
    return (
      <div>
        {showHeading && <h2 className={s.heading}>连接</h2>}
        <div className={s.rowSub}>连接配置仅在桌面端可用。</div>
      </div>
    );
  }

  const tokenPlaceholder = config?.remoteTokenSet
    ? `已保存（${config.remoteTokenPreview ?? "set"}），留空保持不变`
    : "粘贴远程后端的会话令牌";
  const connectionLoaded = Boolean(config) && !loadError;
  const connectionTitle = !connectionLoaded
    ? "正在读取连接状态"
    : envOverride
      ? "连接由环境变量覆盖"
      : `已连接${modeLabel(effectiveMode)}`;
  const connectionDescription = envOverride
    ? `当前会话由环境变量强制连接到远程端（${config?.remoteUrl ?? "远程地址"}），需取消环境变量后才能在此修改。`
    : "软件分为两种顶层使用模式：使用桌面端内置内核，或连接本机其他 / 远端服务器上的外部 Hermes。";
  const connectionBadge = !connectionLoaded ? "读取中" : envOverride ? "环境变量" : modeLabel(effectiveMode);

  return (
    <div>
      {showHeading && <h2 className={s.heading}>连接</h2>}

      <SettingsHero
        ok={connectionLoaded}
        icon={effectiveMode === "remote" || envOverride ? <Globe2 size={24} /> : effectiveMode === "local" ? <Cable size={24} /> : <HardDrive size={24} />}
        eyebrow="Hermes Agent 连接"
        title={connectionTitle}
        description={connectionDescription}
        badge={<span className={s.statusBadge} data-on={connectionLoaded}>{connectionBadge}</span>}
      />

      {loadError && <div className={s.connResult} data-tone="error">{loadError}</div>}

      {envOverride && (
        <div className={s.connEnvWarn}>
          <AlertTriangle size={15} aria-hidden="true" />
          <div>
            <div style={{ fontWeight: 600 }}>当前会话由环境变量强制为远程模式（{config?.remoteUrl}）。</div>
            <div style={{ marginTop: 4 }}>
              取消设置 <code>HERMES_DESKTOP_REMOTE_URL</code> 和 <code>HERMES_DESKTOP_REMOTE_TOKEN</code>{" "}
              后才能在此修改连接。
            </div>
          </div>
        </div>
      )}

      <div className={s.connModeGrid}>
        <ModeCard
          active={mode === "managed"}
          current={effectiveMode === "managed"}
          icon={HardDrive}
          title="内置内核"
          description="由桌面端安装、启动和维护，数据与系统中的其他 Hermes 隔离。"
          disabled={disabled}
          onSelect={() => setMode("managed")}
        />
        <ModeCard
          active={mode !== "managed"}
          current={effectiveMode !== "managed"}
          icon={Globe2}
          title="外部 Hermes"
          description="连接本机另一个 Hermes，或连接远端服务器上的 Hermes。"
          disabled={disabled}
          onSelect={() => setMode(externalKind)}
        />
      </div>

      {mode !== "managed" && (
        <div className={s.connModeGrid} role="radiogroup" aria-label="外部 Hermes 位置" style={{ marginTop: 10 }}>
          <ModeCard
            active={mode === "local"}
            current={effectiveMode === "local"}
            icon={Cable}
            title="本机其他 Hermes"
            description="接入本机已经运行的 Hermes Dashboard，默认使用 127.0.0.1:9119。"
            disabled={disabled}
            onSelect={() => { setExternalKind("local"); setMode("local"); }}
          />
          <ModeCard
            active={mode === "remote"}
            current={effectiveMode === "remote"}
            icon={Globe2}
            title="远端服务器 Hermes"
            description="通过地址和 Token / OAuth 连接另一台机器上的 Hermes。"
            disabled={disabled}
            onSelect={() => { setExternalKind("remote"); setMode("remote"); }}
          />
        </div>
      )}

      {mode === "managed" && <ManagedRuntimePanel compact />}

      {mode === "local" && (
        <div className={s.row}>
          <div className={s.rowLeft}>
            <div className={s.rowLabel}>本地连接地址</div>
            <div className={s.rowSub}>
              仅允许 localhost / 127.0.0.1 / ::1。连接时会自动获取登录所需的会话令牌，无需手动粘贴。
              如果确认本机已安装 Hermes，请先运行 <code>hermes dashboard</code> 启动后端，确认 <code>http://127.0.0.1:9119/</code> 能在浏览器打开，再试一次。
            </div>
          </div>
          <div className={s.rowRight}>
            <Input
              mono
              style={{ minWidth: 280 }}
              value={localUrl}
              placeholder={DEFAULT_LOCAL_URL}
              disabled={disabled}
              onChange={(e) => setLocalUrl(e.target.value)}
              spellCheck={false}
            />
          </div>
        </div>
      )}

      {mode === "remote" && (
        <>
          <div className={s.row}>
            <div className={s.rowLeft}>
              <div className={s.rowLabel}>远程地址</div>
              <div className={s.rowSub}>
                远程 Hermes 后端的地址，支持路径前缀（如 https://gateway.example.com/hermes）。
              </div>
              {probeStatus !== "idle" && (
                <div
                  className={s.connProbe}
                  data-tone={probeStatus === "reachable" ? "ok" : probeStatus === "probing" ? undefined : "error"}
                  aria-live="polite"
                >
                  {probeStatus === "probing" && <Loader2 size={12} className={s.connSpin} />}
                  {probeStatus === "reachable" && <CheckCircle2 size={12} />}
                  {(probeStatus === "unreachable" || probeStatus === "authRequired") && <XCircle size={12} />}
                  {probeStatus === "probing" && "正在检测连接方式…"}
                  {probeStatus === "reachable" && "后端可达"}
                  {probeStatus === "unreachable" && "暂时无法连接，检查地址与网络后会自动重试"}
                  {probeStatus === "authRequired" && "该后端启用了登录门，请在下方登录后再连接"}
                </div>
              )}
            </div>
            <div className={s.rowRight}>
              <Input
                mono
                style={{ minWidth: 280 }}
                value={remoteUrl}
                placeholder="https://gateway.example.com/hermes"
                disabled={disabled}
                onChange={(e) => setRemoteUrl(e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>

          {!gated && (
            <div className={s.row}>
              <div className={s.rowLeft}>
                <div className={s.rowLabel}>会话令牌</div>
                <div className={s.rowSub}>
                  连接远程后端时使用的会话令牌，仅保存在本机，留空保持不变。
                </div>
              </div>
              <div className={s.rowRight}>
                <Input
                  type="password"
                  style={{ minWidth: 280 }}
                  value={tokenInput}
                  placeholder={tokenPlaceholder}
                  disabled={disabled}
                  onChange={(e) => setTokenInput(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
          )}

          {gated && (
            <div className={s.row}>
              <div className={s.rowLeft}>
                <div className={s.rowLabel}>登录</div>
                <div className={s.rowSub}>
                  {identityLabel
                    ? `已登录：${identityLabel}`
                    : "该网关需要登录后才能连接。选择下方登录方式完成登录。"}
                </div>
              </div>
              <div className={s.rowRight} style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
                {identityLabel ? (
                  <Button type="button" variant="outline" onClick={() => void handleLogout()} disabled={disabled}>
                    注销
                  </Button>
                ) : (
                  <>
                    {authProviders
                      .filter((p) => !p.supportsPassword)
                      .map((p) => (
                        <Button
                          key={p.name}
                          type="button"
                          variant="solid"
                          tone="accent"
                          onClick={() => void handleOauthLogin()}
                          disabled={disabled || loggingIn}
                          aria-busy={loggingIn}
                        >
                          {loggingIn && <Loader2 size={13} className={s.connSpin} />}
                          使用 {p.displayName} 登录
                        </Button>
                      ))}
                    {authProviders
                      .filter((p) => p.supportsPassword)
                      .map((p) => (
                        <div key={p.name} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 280 }}>
                          <Input
                            style={{ minWidth: 280 }}
                            value={pwUser}
                            placeholder={`${p.displayName} 用户名`}
                            disabled={disabled || loggingIn}
                            onChange={(e) => setPwUser(e.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <Input
                            type="password"
                            style={{ minWidth: 280 }}
                            value={pwPass}
                            placeholder="密码"
                            disabled={disabled || loggingIn}
                            onChange={(e) => setPwPass(e.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <Button
                            type="button"
                            variant="solid"
                            tone="accent"
                            onClick={() => void handlePasswordLogin(p.name)}
                            disabled={disabled || loggingIn || !pwUser || !pwPass}
                            aria-busy={loggingIn}
                          >
                            {loggingIn && <Loader2 size={13} className={s.connSpin} />}
                            登录
                          </Button>
                        </div>
                      ))}
                    {authProviders.length === 0 && (
                      <div className={s.rowSub}>网关未注册任何登录方式，请检查网关配置。</div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <div className={s.connFooter}>
        {mode !== "managed" && (
          <Button
            type="button"
            className={s.connFooterSpacer}
            variant="outline"
            onClick={() => void handleTest()}
            disabled={disabled || testing || (mode === "local" ? !trimmedLocalUrl : !trimmedRemoteUrl)}
            aria-busy={testing}
          >
            {testing ? <Loader2 size={13} className={s.connSpin} /> : <Cable size={13} />}
            测试连接
          </Button>
        )}
        <Button
          type="button"
          className={mode === "managed" ? s.connFooterSpacer : undefined}
          variant="ghost"
          onClick={() => { window.location.hash = "#/guide"; }}
        >
          重新运行使用引导
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void submit(false)}
          disabled={disabled || !canSubmit}
          aria-busy={saving}
        >
          仅保存（下次启动生效）
        </Button>
        <Button
          type="button"
          variant="solid"
          tone="accent"
          onClick={() => void submit(true)}
          disabled={disabled || !canSubmit}
          aria-busy={applying}
        >
          {applying && <Loader2 size={13} className={s.connSpin} />}
          {mode === "remote" ? "保存并连接远程" : mode === "local" ? "保存并连接本地" : "保存并切回本机内核"}
        </Button>
      </div>

      {message && (
        <Alert className={s.connResult} tone={message.tone} size="sm">
          <div>{message.text}</div>
          {message.hint && <div className={s.connResultHint}>{message.hint}</div>}
        </Alert>
      )}
    </div>
  );
}
