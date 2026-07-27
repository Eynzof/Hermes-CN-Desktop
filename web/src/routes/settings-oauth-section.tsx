import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OAuthProvider } from "@hermes/protocol";
import {
  useOAuthProviders,
  useDisconnectOAuth,
  useStartOAuthLogin,
  useSubmitOAuthCode,
  usePollOAuthSession,
  useCancelOAuthSession,
} from "@/hooks/use-oauth-providers";
import { CopyButton } from "@/components/ui/copy-button";
import { openExternalUrl } from "@/lib/external-links";
import { Badge, Button, Dialog, Input } from "@hermes/shared-ui";
import settings from "./settings.module.css";
import s from "./settings-oauth-section.module.css";

function formatExpiry(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const ms = typeof raw === "number"
    ? (raw > 1e12 ? raw : raw * 1000)
    : Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return "已过期";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} 分钟后过期`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时后过期`;
  return `${Math.floor(hours / 24)} 天后过期`;
}

function isExpired(raw: string | number | null | undefined): boolean {
  if (raw == null) return false;
  const ms = typeof raw === "number"
    ? (raw > 1e12 ? raw : raw * 1000)
    : Date.parse(raw);
  return !Number.isNaN(ms) && ms < Date.now();
}

function badgeStatus(provider: OAuthProvider): "connected" | "expired" | "disconnected" | "error" {
  if (provider.status.error) return "error";
  if (provider.status.logged_in && isExpired(provider.status.expires_at)) return "expired";
  if (provider.status.logged_in) return "connected";
  return "disconnected";
}

function badgeLabel(status: ReturnType<typeof badgeStatus>): string {
  switch (status) {
    case "connected": return "已连接";
    case "expired": return "已过期";
    case "error": return "错误";
    default: return "未连接";
  }
}

function badgeTone(status: ReturnType<typeof badgeStatus>): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "connected": return "success";
    case "expired": return "warning";
    case "error": return "danger";
    default: return "neutral";
  }
}

function flowLabel(flow: string | undefined): string {
  switch (flow) {
    case "pkce": return "浏览器授权";
    case "device_code": return "设备码登录";
    case "loopback": return "浏览器回调";
    case "external": return "外部管理";
    default: return "";
  }
}

export function OAuthProvidersSection() {
  const { data: providers, isLoading, isError, error, refetch } = useOAuthProviders();
  const disconnect = useDisconnectOAuth();
  const [loginProvider, setLoginProvider] = useState<OAuthProvider | null>(null);

  const connectedCount = useMemo(
    () => providers?.filter((p) => p.status.logged_in).length ?? 0,
    [providers],
  );

  const handleDisconnect = useCallback(
    (provider: OAuthProvider) => {
      const confirmed = window.confirm(`确定要断开 ${provider.name} 的 OAuth 登录吗？`);
      if (!confirmed) return;
      disconnect.mutate(provider.id);
    },
    [disconnect],
  );

  if (isLoading) return <div className={s.oauthBlock}><span className={settings.desc}>加载 OAuth 状态…</span></div>;
  if (isError) {
    return (
      <div className={s.oauthBlock}>
        <div className={s.oauthHeader}>
          <div>
            <div className={s.oauthTitle}>OAuth 登录</div>
            <div className={s.oauthDesc}>OAuth 状态加载失败：{error instanceof Error ? error.message : String(error)}</div>
          </div>
          <Button variant="outline" onClick={() => void refetch()}>重试</Button>
        </div>
      </div>
    );
  }
  if (!providers || providers.length === 0) return null;

  return (
    <div className={s.oauthBlock}>
      <div className={s.oauthHeader}>
        <div>
          <div className={s.oauthTitle}>OAuth 登录</div>
          <div className={s.oauthDesc}>
            {connectedCount}/{providers.length} 个 OAuth 登录已连接
          </div>
        </div>
        <Button variant="outline" onClick={() => void refetch()}>刷新</Button>
      </div>

      {providers.map((provider) => {
        const status = badgeStatus(provider);
        const canLogin = !provider.status.logged_in && (
          provider.flow === "pkce" || provider.flow === "device_code" || provider.flow === "loopback"
        );
        const canDisconnect = provider.status.logged_in && provider.flow !== "external";
        const expiry = formatExpiry(provider.status.expires_at);

        return (
          <div key={provider.id} className={s.providerRow}>
            <div className={s.providerLeft}>
              <div className={s.providerName}>{provider.name}</div>
              <div className={s.providerMeta}>
                {flowLabel(provider.flow)}
                {provider.status.source_label && ` · ${provider.status.source_label}`}
                {provider.status.token_preview && <> · <code>{provider.status.token_preview}</code></>}
                {expiry && ` · ${expiry}`}
                {provider.status.error && ` · ${provider.status.error}`}
              </div>
            </div>
            <div className={s.providerRight}>
              <Badge tone={badgeTone(status)} size="sm">{badgeLabel(status)}</Badge>
              {canLogin && (
                <Button variant="solid" tone="accent" onClick={() => setLoginProvider(provider)}>
                  登录
                </Button>
              )}
              {!provider.status.logged_in && provider.flow === "external" && provider.cli_command && (
                <CopyButton variant="outline" size="md" text={provider.cli_command}>
                  复制命令
                </CopyButton>
              )}
              {canDisconnect && (
                <Button
                  variant="outline"
                  tone="danger"
                  disabled={disconnect.isPending}
                  onClick={() => handleDisconnect(provider)}
                >
                  断开
                </Button>
              )}
              {provider.docs_url && (
                <Button variant="outline" onClick={() => void openExternalUrl(provider.docs_url!)}>
                  文档 ↗
                </Button>
              )}
            </div>
          </div>
        );
      })}

      {loginProvider && (
        <OAuthLoginModal
          provider={loginProvider}
          onClose={() => {
            setLoginProvider(null);
            refetch();
          }}
        />
      )}
    </div>
  );
}

/* ── Login Modal ───────────────────────────────────────────────────── */

type LoginPhase = "starting" | "awaiting_user" | "polling" | "approved" | "error";

interface StartResultPkce {
  flow: "pkce";
  session_id: string;
  auth_url: string;
  expires_in: number;
}

interface StartResultDeviceCode {
  flow: "device_code";
  session_id: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  poll_interval: number;
}

interface StartResultLoopback {
  flow: "loopback";
  session_id: string;
  auth_url: string;
  expires_in: number;
}

function OAuthLoginModal({ provider, onClose }: { provider: OAuthProvider; onClose: () => void }) {
  const startLogin = useStartOAuthLogin();
  const submitCode = useSubmitOAuthCode();
  const cancelSession = useCancelOAuthSession();

  const [phase, setPhase] = useState<LoginPhase>("starting");
  const [startResult, setStartResult] = useState<StartResultPkce | StartResultDeviceCode | StartResultLoopback | null>(null);
  const [code, setCode] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [countdown, setCountdown] = useState(0);
  const sessionIdRef = useRef<string | null>(null);

  const polling = usePollOAuthSession(
    provider.id,
    startResult?.flow === "device_code" || startResult?.flow === "loopback" ? startResult.session_id : null,
    phase === "polling",
  );

  useEffect(() => {
    startLogin.mutateAsync(provider.id).then((result) => {
      setStartResult(result as StartResultPkce | StartResultDeviceCode | StartResultLoopback);
      sessionIdRef.current = result.session_id;
      setCountdown(result.expires_in);

      if (result.flow === "pkce") {
        void openExternalUrl(result.auth_url);
        setPhase("awaiting_user");
      } else if (result.flow === "loopback") {
        void openExternalUrl(result.auth_url);
        setPhase("polling");
      } else {
        void openExternalUrl(result.verification_url);
        setPhase("polling");
      }
    }).catch((err) => {
      setErrorMsg(err instanceof Error ? err.message : "启动登录失败");
      setPhase("error");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          if (phase === "awaiting_user" || phase === "polling") {
            setPhase("error");
            setErrorMsg("授权会话已过期，请重试");
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown > 0, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!polling.data) return;
    if (polling.data.status === "approved") {
      setPhase("approved");
      setTimeout(onClose, 1500);
    } else if (polling.data.status === "denied" || polling.data.status === "expired" || polling.data.status === "error") {
      setPhase("error");
      setErrorMsg(polling.data.error_message ?? `授权${polling.data.status === "denied" ? "被拒绝" : polling.data.status === "expired" ? "已过期" : "失败"}`);
    }
  }, [polling.data, onClose]);

  const handleSubmitCode = useCallback(async () => {
    if (!startResult || startResult.flow !== "pkce" || !code.trim()) return;
    try {
      const res = await submitCode.mutateAsync({
        providerId: provider.id,
        sessionId: startResult.session_id,
        code: code.trim(),
      });
      if (res.status === "approved") {
        setPhase("approved");
        setTimeout(onClose, 1500);
      } else {
        setPhase("error");
        setErrorMsg(res.message ?? "授权码验证失败");
      }
    } catch (err) {
      setPhase("error");
      setErrorMsg(err instanceof Error ? err.message : "提交失败");
    }
  }, [code, onClose, provider.id, startResult, submitCode]);

  const handleClose = useCallback(() => {
    if (sessionIdRef.current && phase !== "approved") {
      cancelSession.mutate(sessionIdRef.current);
    }
    onClose();
  }, [cancelSession, onClose, phase]);

  const formatCountdown = (secs: number) => {
    const m = Math.floor(secs / 60);
    const sec = secs % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) handleClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.modalBackdrop} />
        <Dialog.Content className={s.modal} aria-describedby={undefined}>
        <div className={s.modalHeader}>
          <Dialog.Title asChild>
            <div className={s.modalTitle}>登录 {provider.name}</div>
          </Dialog.Title>
          <Dialog.Close asChild>
            <Button variant="plain" size="inherit" className={s.modalClose} aria-label="关闭">✕</Button>
          </Dialog.Close>
        </div>

        {phase === "starting" && (
          <div className={s.statusMessage} data-type="pending">正在启动授权流程…</div>
        )}

        {phase === "awaiting_user" && startResult?.flow === "pkce" && (
          <>
            <ol className={s.steps}>
              <li>浏览器已打开授权页面，请完成登录授权</li>
              <li>授权完成后，复制页面上显示的授权码</li>
              <li>将授权码粘贴到下方输入框</li>
            </ol>
            <Input
              className={s.codeInput}
              mono
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="粘贴授权码…"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmitCode(); }}
            />
            <div className={s.modalActions}>
              <Button
                variant="solid"
                tone="accent"
                disabled={!code.trim() || submitCode.isPending}
                onClick={handleSubmitCode}
              >
                {submitCode.isPending ? "验证中…" : "提交"}
              </Button>
              <button
                className={s.linkBtn}
                onClick={() => void openExternalUrl((startResult as StartResultPkce).auth_url)}
              >
                重新打开授权页
              </button>
            </div>
            {countdown > 0 && <div className={s.countdown}>剩余时间: {formatCountdown(countdown)}</div>}
          </>
        )}

        {phase === "polling" && startResult?.flow === "device_code" && (
          <>
            <p style={{ fontSize: 13, color: "var(--h-text)", margin: "0 0 8px" }}>
              请在打开的页面中输入以下验证码:
            </p>
            <div className={s.userCode}>{startResult.user_code}</div>
            <div className={s.modalActions}>
              <CopyButton variant="outline" size="md" text={startResult.user_code}>
                复制验证码
              </CopyButton>
              <button
                className={s.linkBtn}
                onClick={() => void openExternalUrl(startResult.verification_url)}
              >
                重新打开验证页
              </button>
            </div>
            <div className={s.statusMessage} data-type="pending">等待授权中…</div>
            {countdown > 0 && <div className={s.countdown}>剩余时间: {formatCountdown(countdown)}</div>}
          </>
        )}

        {phase === "polling" && startResult?.flow === "loopback" && (
          <>
            <p style={{ fontSize: 13, color: "var(--h-text)", margin: "0 0 8px" }}>
              浏览器已打开授权页；授权完成后会自动回到本机回调地址，无需复制验证码。
            </p>
            <div className={s.modalActions}>
              <button
                className={s.linkBtn}
                onClick={() => void openExternalUrl(startResult.auth_url)}
              >
                重新打开授权页
              </button>
            </div>
            <div className={s.statusMessage} data-type="pending">等待浏览器回调中…</div>
            {countdown > 0 && <div className={s.countdown}>剩余时间: {formatCountdown(countdown)}</div>}
          </>
        )}

        {phase === "approved" && (
          <div className={s.statusMessage} data-type="success">已成功连接，正在关闭…</div>
        )}

        {phase === "error" && (
          <>
            <div className={s.statusMessage} data-type="error">{errorMsg}</div>
            <div className={s.modalActions}>
              <Dialog.Close asChild>
                <Button variant="outline">关闭</Button>
              </Dialog.Close>
            </div>
          </>
        )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
