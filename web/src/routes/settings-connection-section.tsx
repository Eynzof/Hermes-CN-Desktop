// Settings → 连接: choose between the local managed runtime and a remote
// Hermes Agent (shell mode). Token-auth-only port of the official desktop's
// gateway-settings UI (Hermes-CN-Core apps/desktop/src/app/settings/
// gateway-settings.tsx), matching its product shape: side-by-side mode cards,
// a debounced reachability probe under the URL field, a session-token entry
// that never round-trips the saved secret, a prominent env-override warning,
// and a Test / Save-for-next-restart / Save-and-reconnect button row.
//
// The official UI additionally offers OAuth sign-in and per-profile scopes;
// this v1 is token-only and global (see the connection.rs scope decision).
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
import s from "./settings.module.css";

interface SettingsSectionProps {
  showHeading?: boolean;
}

type ProbeStatus = "idle" | "probing" | "reachable" | "unreachable" | "authRequired";

const PROBE_DEBOUNCE_MS = 500;

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
  const [mode, setMode] = useState<ConnectionMode>("local");
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
        setRemoteUrl(view.remoteUrl);
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, [desktop]);

  const envOverride = config?.envOverride ?? false;
  const busy = saving || applying;
  const disabled = !supported || envOverride || busy;
  const trimmedUrl = remoteUrl.trim();
  const effectiveMode = config?.effectiveMode ?? "local";

  // Debounced as-you-type reachability probe, sequence-guarded so a slow
  // response for an old URL can't overwrite the status of the current one.
  useEffect(() => {
    if (mode !== "remote" || envOverride || !/^https?:\/\//i.test(trimmedUrl)) {
      setProbeStatus("idle");
      return;
    }
    const seq = ++probeSeq.current;
    setProbeStatus("probing");
    const timer = window.setTimeout(() => {
      desktop
        ?.probeConnectionConfig?.(trimmedUrl)
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
  }, [mode, trimmedUrl, envOverride]);

  // Enough to submit a remote connection: a URL plus either a freshly typed
  // token or a previously saved one (mirrors the official canUseRemote gate).
  const remoteReady = mode === "local" || Boolean(trimmedUrl && (tokenInput.trim() || config?.remoteTokenSet));

  const handleTest = async () => {
    if (!desktop?.testConnectionConfig) return;
    setMessage(null);
    setTesting(true);
    try {
      const result = await desktop.testConnectionConfig({
        remoteUrl: trimmedUrl || undefined,
        remoteToken: tokenInput || undefined,
      });
      setMessage(testResultSummary(result));
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  const submit = async (apply: boolean) => {
    if (mode === "remote" && !remoteReady) {
      setMessage({ tone: "error", text: "请先填写远程地址和 session token" });
      return;
    }
    setMessage(null);
    const setBusy = apply ? setApplying : setSaving;
    setBusy(true);
    try {
      const payload = {
        mode,
        remoteUrl: mode === "remote" ? trimmedUrl : undefined,
        remoteToken: tokenInput || undefined,
      };
      if (apply) {
        const result = await desktop!.applyConnectionConfig!(payload);
        if (result.ok) {
          // The connection mode feeds transport routing, socket-path selection
          // and every query cache — a clean reload rebuilds it all from
          // get_runtime_config, exactly like a fresh boot.
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

  return (
    <div>
      {showHeading && <h2 className={s.heading}>连接</h2>}

      <div className={s.approvalModeHead}>
        <Globe2 size={14} aria-hidden="true" />
        <div>
          <h3>
            网关连接
            {envOverride && <span className={s.approvalModeBadge} style={{ marginLeft: 8 }}>环境变量覆盖</span>}
          </h3>
          <p>
            桌面端默认在本机启动自己的 Hermes 内核。当你想把它当作「壳」连接另一台机器上已运行的 Hermes
            Agent 时，选择远程模式。当前版本仅支持 session token 认证。
          </p>
        </div>
      </div>

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
          active={mode === "local"}
          current={effectiveMode === "local"}
          icon={HardDrive}
          title="本机内核"
          description="在本机启动私有 Hermes 后端，默认且可离线运行。"
          disabled={disabled}
          onSelect={() => setMode("local")}
        />
        <ModeCard
          active={mode === "remote"}
          current={effectiveMode === "remote"}
          icon={Globe2}
          title="远程 Hermes Agent"
          description="把桌面端作为界面壳连接另一台机器上的 Hermes 后端，使用 session token 认证。"
          disabled={disabled}
          onSelect={() => setMode("remote")}
        />
      </div>

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
                  data-tone={
                    probeStatus === "reachable"
                      ? "ok"
                      : probeStatus === "probing"
                        ? undefined
                        : "error"
                  }
                  aria-live="polite"
                >
                  {probeStatus === "probing" && <Loader2 size={12} className={s.connSpin} />}
                  {probeStatus === "reachable" && <CheckCircle2 size={12} />}
                  {(probeStatus === "unreachable" || probeStatus === "authRequired") && <XCircle size={12} />}
                  {probeStatus === "probing" && "正在探测网关认证方式…"}
                  {probeStatus === "reachable" && "网关可达"}
                  {probeStatus === "unreachable" && "暂时无法连接该网关，检查地址与网络后会自动重试"}
                  {probeStatus === "authRequired" && "该网关需要 OAuth 登录，当前版本仅支持 session token"}
                </div>
              )}
            </div>
            <div className={s.rowRight}>
              <input
                className={s.fieldInput}
                data-mono="true"
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
                远程端用于 REST 与 WebSocket 鉴权的会话令牌（启动远程 dashboard 时由
                HERMES_DASHBOARD_SESSION_TOKEN 指定）。仅保存在本机，留空保持不变。
              </div>
            </div>
            <div className={s.rowRight}>
              <input
                className={s.fieldInput}
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
        {mode === "remote" && (
          <button
            type="button"
            className={`${s.btn} ${s.connFooterSpacer}`}
            onClick={() => void handleTest()}
            disabled={disabled || testing || !trimmedUrl}
            aria-busy={testing}
          >
            {testing ? <Loader2 size={13} className={s.connSpin} /> : <Cable size={13} />}
            测试连接
          </button>
        )}
        <button
          type="button"
          className={s.btn}
          onClick={() => void submit(false)}
          disabled={disabled || (mode === "remote" && !remoteReady)}
          aria-busy={saving}
        >
          仅保存（下次启动生效）
        </button>
        <button
          type="button"
          className={s.btnPrimary}
          onClick={() => void submit(true)}
          disabled={disabled || (mode === "remote" && !remoteReady)}
          aria-busy={applying}
        >
          {applying && <Loader2 size={13} className={s.connSpin} />}
          {mode === "remote" ? "保存并连接远程" : "保存并切回本机"}
        </button>
      </div>

      {message && (
        <div className={s.connResult} data-tone={message.tone}>
          {message.text}
        </div>
      )}
    </div>
  );
}
