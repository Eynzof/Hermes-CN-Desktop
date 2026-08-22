import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  useSpotifyStatus,
  useSpotifyLogin,
  useSpotifyDisconnect,
  type SpotifyLoginInput,
} from "@/hooks/use-spotify";
import { openExternalUrl } from "@/lib/external-links";
import { Badge, Button, Input, LoadingState } from "@hermes/shared-ui";
import s from "./settings-oauth-section.module.css";

type LoginPhase = "idle" | "starting" | "awaiting" | "exchanging" | "connected" | "error";

function formatExpiry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return "已过期";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} 分钟后过期`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时后过期`;
  return `${Math.floor(hours / 24)} 天后过期`;
}

function isExpired(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const ms = Date.parse(raw);
  return !Number.isNaN(ms) && ms < Date.now();
}

function statusTone(
  connected: boolean,
  expired: boolean,
  error?: string,
): "success" | "warning" | "danger" | "neutral" {
  if (error) return "danger";
  if (connected && expired) return "warning";
  if (connected) return "success";
  return "neutral";
}

export function SpotifySettingsSection() {
  const { data: state, isLoading, isError, error, refetch } = useSpotifyStatus();
  const login = useSpotifyLogin();
  const disconnect = useSpotifyDisconnect();
  const [showModal, setShowModal] = useState(false);

  const connected = Boolean(state?.access_token);
  const expired = isExpired(state?.expires_at);
  const tone = statusTone(connected, expired, state?.last_auth_error?.error);
  const label = state?.last_auth_error ? "错误" : connected ? (expired ? "已过期" : "已连接") : "未连接";

  return (
    <div className={s.oauthBlock}>
      <div className={s.oauthHeader}>
        <div>
          <div className={s.oauthTitle}>Spotify</div>
          <div className={s.oauthDesc}>
            通过 PKCE OAuth 连接 Spotify，支持播放控制、搜索、播放列表和曲库工具。
          </div>
        </div>
        <Button variant="outline" onClick={() => void refetch()}>
          刷新
        </Button>
      </div>

      <div className={s.providerRow}>
        <div className={s.providerLeft}>
          <div className={s.providerName}>Spotify</div>
          <div className={s.providerMeta}>
            {state?.client_id && `Client ID: ${state.client_id.slice(0, 8)}…`}
            {state?.expires_at && ` · ${formatExpiry(state.expires_at)}`}
            {state?.last_auth_error?.error && ` · ${state.last_auth_error.error}`}
          </div>
        </div>
        <div className={s.providerRight}>
          <Badge tone={tone} size="sm">
            {label}
          </Badge>
          {!connected && (
            <Button variant="solid" tone="accent" onClick={() => setShowModal(true)}>
              连接
            </Button>
          )}
          {connected && (
            <Button
              variant="outline"
              tone="danger"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              断开
            </Button>
          )}
        </div>
      </div>

      {showModal && <SpotifyLoginModal onClose={() => setShowModal(false)} />}
    </div>
  );
}

function SpotifyLoginModal({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<LoginPhase>("idle");
  const [clientId, setClientId] = useState("");
  const [redirectUri, setRedirectUri] = useState("http://127.0.0.1:43827/spotify/callback");
  const [errorMsg, setErrorMsg] = useState("");
  const login = useSpotifyLogin();
  const abortRef = useRef(false);

  const handleStart = useCallback(async () => {
    if (!clientId.trim()) {
      setErrorMsg("请输入 Spotify Client ID");
      setPhase("error");
      return;
    }
    setPhase("starting");
    setErrorMsg("");
    abortRef.current = false;
    const input: SpotifyLoginInput = {
      clientId: clientId.trim(),
      redirectUri: redirectUri.trim() || undefined,
    };
    try {
      setPhase("awaiting");
      await login.mutateAsync(input);
      if (!abortRef.current) {
        setPhase("connected");
        setTimeout(onClose, 1500);
      }
    } catch (err) {
      if (!abortRef.current) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    }
  }, [clientId, redirectUri, login, onClose]);

  const handleClose = useCallback(() => {
    abortRef.current = true;
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handleClose]);

  return createPortal(
    <div className={s.modalBackdrop} onClick={handleClose}>
      <div className={s.modal} onClick={(e) => e.stopPropagation()}>
        <div className={s.modalHeader}>
          <div className={s.modalTitle}>连接 Spotify</div>
          <Button
            variant="plain"
            size="xs"
            className={s.modalClose}
            onClick={handleClose}
            aria-label="关闭"
          >
            ✕
          </Button>
        </div>

        {phase === "idle" && (
          <>
            <p className={s.oauthDesc} style={{ marginBottom: 12 }}>
              在{" "}
              <button
                className={s.linkBtn}
                onClick={() => void openExternalUrl("https://developer.spotify.com/dashboard")}
              >
                Spotify Developer Dashboard
              </button>{" "}
              创建应用，并将下方 Redirect URI 加入允许列表。
            </p>
            <Input
              className={s.codeInput}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="Spotify Client ID"
              autoFocus
            />
            <Input
              className={s.codeInput}
              value={redirectUri}
              onChange={(e) => setRedirectUri(e.target.value)}
              placeholder="Redirect URI"
            />
            <div className={s.modalActions}>
              <Button
                variant="solid"
                tone="accent"
                loading={login.isPending}
                disabled={!clientId.trim()}
                onClick={handleStart}
              >
                打开授权页
              </Button>
            </div>
          </>
        )}

        {phase === "starting" && (
          <div className={s.statusMessage} data-type="pending">
            正在启动本地回调监听…
          </div>
        )}

        {phase === "awaiting" && (
          <>
            <ol className={s.steps}>
              <li>浏览器已打开 Spotify 授权页</li>
              <li>完成授权后，页面会自动跳转回本地回调地址</li>
              <li>桌面端将自动获取授权码并完成登录</li>
            </ol>
            <div className={s.statusMessage} data-type="pending">
              等待授权回调…
            </div>
          </>
        )}

        {phase === "connected" && (
          <div className={s.statusMessage} data-type="success">
            Spotify 已连接
          </div>
        )}

        {phase === "error" && (
          <div className={s.statusMessage} data-type="error">
            {errorMsg || "连接失败"}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
