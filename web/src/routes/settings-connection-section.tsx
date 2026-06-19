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
  ConnectionConfigView,
  ConnectionMode,
  TestConnectionResult,
} from "@hermes/protocol";
import { Alert, Button, Input } from "@hermes/shared-ui";
import { SettingsHero } from "./settings-hero";
import s from "./settings.module.css";

interface SettingsSectionProps {
  showHeading?: boolean;
}

type ProbeStatus = "idle" | "probing" | "reachable" | "unreachable" | "authRequired";

const PROBE_DEBOUNCE_MS = 500;
const DEFAULT_LOCAL_URL = "http://127.0.0.1:9119";

function modeLabel(mode: ConnectionMode | undefined): string {
  if (mode === "remote") return "远程连接";
  if (mode === "local") return "本地连接";
  return "本机内核";
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

function testResultSummary(result: TestConnectionResult): { tone: "ok" | "error"; text: string } {
  if (result.ok) {
    const version = result.version ? ` · Hermes ${result.version}` : "";
    return { tone: "ok", text: `连接正常：HTTP 与 WebSocket 均可用（${result.baseUrl}${version}）` };
  }
  const detail = result.error ?? "连接失败";
  const parts = [
    `HTTP ${result.httpOk ? "✓" : `✗${result.httpStatus ? ` (${result.httpStatus})` : ""}`}`,
    `WebSocket ${result.wsOk ? "✓" : "✗"}`,
  ];
  return { tone: "error", text: `${detail}　[${parts.join("，")}]` };
}

export function ConnectionSection({ showHeading = true }: SettingsSectionProps) {
  const desktop = typeof window !== "undefined" ? window.hermesDesktop : undefined;
  const supported = Boolean(desktop?.getConnectionConfig);

  const [config, setConfig] = useState<ConnectionConfigView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<ConnectionMode>("managed");
  const [localUrl, setLocalUrl] = useState(DEFAULT_LOCAL_URL);
  const [remoteUrl, setRemoteUrl] = useState("");
  // The saved token never round-trips; this holds only what the user types.
  const [tokenInput, setTokenInput] = useState("");
  const [probeStatus, setProbeStatus] = useState<ProbeStatus>("idle");
  const probeSeq = useRef(0);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!desktop?.getConnectionConfig) return;
    desktop
      .getConnectionConfig()
      .then((view) => {
        setConfig(view);
        setMode(view.mode);
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
          else if (result.authRequired) setProbeStatus("authRequired");
          else setProbeStatus("reachable");
        })
        .catch(() => {
          if (seq !== probeSeq.current) return;
          setProbeStatus("unreachable");
        });
    }, PROBE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, trimmedRemoteUrl, envOverride]);

  const remoteReady = Boolean(trimmedRemoteUrl && (tokenInput.trim() || config?.remoteTokenSet));
  const localReady = Boolean(trimmedLocalUrl);
  const canSubmit = mode === "managed" || (mode === "local" ? localReady : remoteReady);

  const handleTest = async () => {
    if (!desktop?.testConnectionConfig || mode === "managed") return;
    setMessage(null);
    setTesting(true);
    try {
      const result = await desktop.testConnectionConfig({
        mode,
        localUrl: mode === "local" ? trimmedLocalUrl : undefined,
        remoteUrl: mode === "remote" ? trimmedRemoteUrl : undefined,
        remoteToken: mode === "remote" ? tokenInput || undefined : undefined,
      });
      setMessage(testResultSummary(result));
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  const submit = async (apply: boolean) => {
    if (!canSubmit) {
      setMessage({
        tone: "error",
        text: mode === "remote" ? "请先填写远程地址和 session token" : "请先填写本地连接地址",
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
        remoteToken: mode === "remote" ? tokenInput || undefined : undefined,
      };
      if (apply) {
        const result = await desktop!.applyConnectionConfig!(payload);
        if (result.ok) {
          setMessage({ tone: "ok", text: "已切换，正在重新加载界面…" });
          window.setTimeout(() => window.location.reload(), 600);
          return;
        }
        setMessage({ tone: "error", text: result.error ?? "切换失败" });
      } else {
        const view = await desktop!.saveConnectionConfig!(payload);
        setConfig(view);
        setTokenInput("");
        setMessage({ tone: "ok", text: "已保存，下次启动桌面端时生效" });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
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
    : "粘贴远程 Dashboard 的 session token";
  const connectionLoaded = Boolean(config) && !loadError;
  const connectionTitle = !connectionLoaded
    ? "正在读取网关连接状态"
    : envOverride
      ? "网关连接由环境变量覆盖"
      : `已连接${modeLabel(effectiveMode)}`;
  const connectionDescription = envOverride
    ? `当前会话由环境变量强制连接到远程端（${config?.remoteUrl ?? "远程地址"}），需取消环境变量后才能在此修改。`
    : "桌面端现在支持三种连接：本机内核由桌面端管理 9120；本地连接自动接入本机 CLI dashboard 9119；远程连接继续使用 session token。";
  const connectionBadge = !connectionLoaded ? "读取中" : envOverride ? "环境变量" : modeLabel(effectiveMode);

  return (
    <div>
      {showHeading && <h2 className={s.heading}>连接</h2>}

      <SettingsHero
        ok={connectionLoaded}
        icon={effectiveMode === "remote" || envOverride ? <Globe2 size={24} /> : effectiveMode === "local" ? <Cable size={24} /> : <HardDrive size={24} />}
        eyebrow="Hermes Agent 网关连接"
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
          title="本机内核"
          description="桌面端启动并管理私有 Hermes runtime，默认端口 9120，适合离线和独立使用。"
          disabled={disabled}
          onSelect={() => setMode("managed")}
        />
        <ModeCard
          active={mode === "local"}
          current={effectiveMode === "local"}
          icon={Cable}
          title="本地连接"
          description="连接本机已运行的 Hermes Agent CLI dashboard，默认 http://127.0.0.1:9119。"
          disabled={disabled}
          onSelect={() => setMode("local")}
        />
        <ModeCard
          active={mode === "remote"}
          current={effectiveMode === "remote"}
          icon={Globe2}
          title="远程连接"
          description="把桌面端作为界面壳连接另一台机器上的 Hermes 后端，使用 session token 认证。"
          disabled={disabled}
          onSelect={() => setMode("remote")}
        />
      </div>

      {mode === "local" && (
        <div className={s.row}>
          <div className={s.rowLeft}>
            <div className={s.rowLabel}>本地 Dashboard 地址</div>
            <div className={s.rowSub}>
              仅允许 localhost / 127.0.0.1 / ::1。连接时会自动从本机 dashboard 页面读取 session token，不需要手动粘贴。
              若 9119 端口提示未连接，请先在命令行中输入 <code>hermes dashboard</code> 启动 dashboard。
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
                远程 hermes dashboard 后端的基础 URL，支持路径前缀（如 https://gateway.example.com/hermes）。
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
                  {probeStatus === "probing" && "正在探测网关认证方式…"}
                  {probeStatus === "reachable" && "网关可达"}
                  {probeStatus === "unreachable" && "暂时无法连接该网关，检查地址与网络后会自动重试"}
                  {probeStatus === "authRequired" && "该网关需要 OAuth 登录，本轮远程连接仍仅支持 session token"}
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

          <div className={s.row}>
            <div className={s.rowLeft}>
              <div className={s.rowLabel}>Session Token</div>
              <div className={s.rowSub}>
                远程端用于 REST 与 WebSocket 鉴权的会话令牌。仅保存在本机，留空保持不变。
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
          {message.text}
        </Alert>
      )}
    </div>
  );
}
