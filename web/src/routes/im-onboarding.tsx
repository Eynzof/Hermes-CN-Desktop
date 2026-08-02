import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import QRCode from "qrcode";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  MessageCircle,
  MessageSquareText,
  RefreshCw,
  RotateCw,
  ScanLine,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type {
  ImOnboardingApplyResult,
  ImOnboardingBeginResult,
  ImOnboardingPollResult,
  ImPlatform,
  ImRedactedValue,
  MessagingPlatformTestResponse,
} from "@hermes/protocol";
import {
  useApplyImOnboarding,
  useBeginImOnboarding,
  useImOnboardingState,
  useMessagingPlatform,
  usePollImOnboarding,
  useTestMessagingPlatform,
} from "@/hooks/use-im-onboarding";
import { openExternalUrl } from "@/lib/external-links";
import { SectionShell } from "./section-shell";
import s from "./im-onboarding.module.css";

type ImSection = "overview" | ImPlatform;

const FEISHU_DEVELOPER_URL = "https://open.feishu.cn/app";
const FEISHU_SCANNED_OPEN_ID_TOKEN = "__HERMES_SCANNED_FEISHU_OPEN_ID__";
const WEIXIN_SCANNED_USER_ID_TOKEN = "__HERMES_SCANNED_WEIXIN_USER_ID__";

export const FEISHU_REQUIRED_SCOPES = [
  "im:message.p2p_msg:readonly",
  "im:message:send_as_bot",
] as const;
export const FEISHU_RECEIVE_EVENT = "im.message.receive_v1";

interface PlatformCopy {
  id: ImPlatform;
  name: string;
  eyebrow: string;
  summary: string;
  detail: string;
  qrHint: string;
  icon: LucideIcon;
}

const PLATFORM_COPY: Record<ImPlatform, PlatformCopy> = {
  feishu: {
    id: "feishu",
    name: "飞书",
    eyebrow: "FEISHU",
    summary: "在飞书里直接找 Hermes",
    detail: "扫码后自动完成接入。默认所有私聊都可用，无需设置用户范围。",
    qrHint: "打开飞书，扫描二维码并确认授权。",
    icon: MessageCircle,
  },
  weixin: {
    id: "weixin",
    name: "微信",
    eyebrow: "WEIXIN",
    summary: "在微信里随时使用 Hermes",
    detail: "扫码后自动保存接入信息，默认仅本次扫码账号可用。",
    qrHint: "打开微信，扫描二维码并在手机上确认。",
    icon: MessageSquareText,
  },
};

export function sectionFromPath(pathname: string): ImSection | null {
  if (["/assistant", "/assistant/", "/im", "/im/"].includes(pathname)) return "overview";
  if (pathname === "/assistant/feishu" || pathname === "/im/feishu") return "feishu";
  if (pathname === "/assistant/weixin" || pathname === "/im/weixin") return "weixin";
  return null;
}

export function statusText(status?: string): string {
  switch (status) {
    case "confirmed": return "已确认";
    case "scanned": return "已扫码，请在手机上确认";
    case "expired_refreshed": return "二维码已刷新";
    case "expired": return "二维码已过期";
    case "denied": return "已取消授权";
    case "pending": return "等待扫码";
    default: return status || "待开始";
  }
}

export function defaultSettings(platform: ImPlatform, hasScannedUser: boolean): Record<string, string> {
  if (platform === "feishu") {
    return {
      FEISHU_DOMAIN: "feishu",
      FEISHU_CONNECTION_MODE: "websocket",
      FEISHU_ALLOW_ALL_USERS: "true",
      FEISHU_ALLOWED_USERS: "",
      FEISHU_GROUP_POLICY: "disabled",
      FEISHU_REQUIRE_MENTION: "true",
      ...(hasScannedUser ? { FEISHU_HOME_CHANNEL: FEISHU_SCANNED_OPEN_ID_TOKEN } : {}),
    };
  }
  return {
    WEIXIN_DM_POLICY: hasScannedUser ? "allowlist" : "pairing",
    WEIXIN_ALLOW_ALL_USERS: "false",
    WEIXIN_ALLOWED_USERS: hasScannedUser ? WEIXIN_SCANNED_USER_ID_TOKEN : "",
    WEIXIN_GROUP_POLICY: "disabled",
    ...(hasScannedUser ? { WEIXIN_HOME_CHANNEL: WEIXIN_SCANNED_USER_ID_TOKEN } : {}),
  };
}

function isSet(value?: ImRedactedValue | null): value is ImRedactedValue {
  return Boolean(value?.isSet);
}

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function Button({
  children,
  onClick,
  disabled,
  kind = "secondary",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary" | "quiet";
  type?: "button" | "submit";
}) {
  return (
    <button className={s.button} data-kind={kind} type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function ConnectionState({ connected, configured }: { connected: boolean; configured: boolean }) {
  const label = connected ? "已连接" : configured ? "待检测" : "未接入";
  return (
    <span className={s.connectionState} data-tone={connected ? "success" : configured ? "pending" : "muted"}>
      <span aria-hidden="true" />{label}
    </span>
  );
}

function PlatformOverviewCard({ platform }: { platform: ImPlatform }) {
  const stateQuery = useImOnboardingState(platform);
  const platformQuery = useMessagingPlatform(platform);
  const copy = PLATFORM_COPY[platform];
  const Icon = copy.icon;
  const configured = platform === "feishu"
    ? Boolean(stateQuery.data?.configured.FEISHU_APP_ID?.isSet && stateQuery.data?.configured.FEISHU_APP_SECRET?.isSet)
    : Boolean(stateQuery.data?.configured.WEIXIN_ACCOUNT_ID?.isSet && stateQuery.data?.configured.WEIXIN_TOKEN?.isSet);
  const connected = platformQuery.data?.state === "connected";

  return (
    <Link className={s.platformCard} to={`/assistant/${platform}`}>
      <span className={s.platformIcon}><Icon size={22} /></span>
      <span className={s.platformCardCopy}>
        <span className={s.eyebrow}>{copy.eyebrow}</span>
        <strong>{copy.name}</strong>
        <b>{copy.summary}</b>
        <small>{copy.detail}</small>
      </span>
      <span className={s.platformCardEnd}>
        <ConnectionState connected={connected} configured={configured} />
        <ArrowRight size={18} />
      </span>
    </Link>
  );
}

function OverviewRoute() {
  return (
    <SectionShell title="助理" sub="将 Hermes 接入常用聊天工具">
      <div className={s.pageWrap}>
        <header className={s.intro}>
          <span className={s.eyebrow}>ASSISTANT</span>
          <h1>让 Hermes 在聊天里随时待命</h1>
          <p>选择一个平台，扫码后即可开始对话。接入信息会自动保存到当前档案。</p>
        </header>
        <div className={s.platformGrid} aria-label="可接入的平台">
          <PlatformOverviewCard platform="feishu" />
          <PlatformOverviewCard platform="weixin" />
        </div>
        <div className={s.privacyNote}>
          <ShieldCheck size={17} />
          <div><b>接入信息保存在本机</b><span>切换档案时，各档案的接入状态彼此独立。</span></div>
        </div>
      </div>
    </SectionShell>
  );
}

function QrCode({ value, label }: { value?: string | null; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    if (!value) return;
    QRCode.toDataURL(value, { width: 224, margin: 1, errorCorrectionLevel: "M" })
      .then((next) => { if (!cancelled) setSrc(next); })
      .catch(() => { if (!cancelled) setSrc(null); });
    return () => { cancelled = true; };
  }, [value]);

  return (
    <div className={s.qrBox}>
      {src ? <img src={src} alt={`${label}接入二维码`} /> : <LoaderCircle className={s.spin} size={28} aria-label="正在生成二维码" />}
    </div>
  );
}

function ProgressSteps({ hasCredentials, saved, connected }: {
  hasCredentials: boolean;
  saved: boolean;
  connected: boolean;
}) {
  const steps = [
    { label: "扫码确认", done: hasCredentials },
    { label: "自动保存", done: saved },
    { label: "连接完成", done: connected },
  ];
  const activeIndex = steps.findIndex((step) => !step.done);
  return (
    <ol className={s.steps}>
      {steps.map((step, index) => (
        <li key={step.label} data-done={step.done ? "true" : undefined} data-active={index === activeIndex ? "true" : undefined}>
          <span>{step.done ? <Check size={14} /> : index + 1}</span><b>{step.label}</b>
        </li>
      ))}
    </ol>
  );
}

function FeishuFailureHelp({ result }: { result: MessagingPlatformTestResponse }) {
  const scopes = FEISHU_REQUIRED_SCOPES.join("\n");
  const copyScopes = () => void navigator.clipboard?.writeText(scopes);
  return (
    <section className={s.failureHelp} aria-label="飞书连接处理提示">
      <div className={s.failureHeading}>
        <CircleAlert size={19} />
        <div><b>飞书还没有连接成功</b><span>{result.message}</span></div>
      </div>
      <p>扫码信息已经保存。请到飞书开放平台确认下面三项，然后回来重新检测：</p>
      <ol>
        <li><span>1</span><div><b>启用机器人</b><small>在应用能力中添加机器人。</small></div></li>
        <li><span>2</span><div><b>接收消息</b><small>选择长连接，并订阅 <code>{FEISHU_RECEIVE_EVENT}</code>。</small></div></li>
        <li><span>3</span><div><b>添加权限并发布</b><small>加入私聊消息与机器人发消息权限，创建版本并发布。</small></div></li>
      </ol>
      <div className={s.failureActions}>
        <Button kind="primary" onClick={() => void openExternalUrl(FEISHU_DEVELOPER_URL)}><ExternalLink size={15} />打开飞书开放平台</Button>
        <Button onClick={copyScopes}>复制所需权限</Button>
      </div>
    </section>
  );
}

export function shouldShowFeishuRecovery(
  platform: ImPlatform,
  result?: MessagingPlatformTestResponse | null,
): boolean {
  return platform === "feishu" && Boolean(result && !result.ok);
}

function WeixinFailureHelp({ result, onRestart }: { result: MessagingPlatformTestResponse; onRestart: () => void }) {
  return (
    <section className={s.failureHelp} aria-label="微信连接处理提示">
      <div className={s.failureHeading}>
        <CircleAlert size={19} />
        <div><b>微信还没有连接成功</b><span>{result.message}</span></div>
      </div>
      <p>先重新检测一次；如果仍然失败，请重新扫码更新接入信息。</p>
      <Button onClick={onRestart}><ScanLine size={15} />重新扫码</Button>
    </section>
  );
}

function ConnectorRoute({
  platform,
  showBackLink = true,
}: {
  platform: ImPlatform;
  showBackLink?: boolean;
}) {
  const copy = PLATFORM_COPY[platform];
  const Icon = copy.icon;
  const stateQuery = useImOnboardingState(platform);
  const platformQuery = useMessagingPlatform(platform);
  const begin = useBeginImOnboarding();
  const poll = usePollImOnboarding();
  const apply = useApplyImOnboarding(platform);
  const testPlatform = useTestMessagingPlatform(platform);
  const [flow, setFlow] = useState<ImOnboardingBeginResult | null>(null);
  const [pollResult, setPollResult] = useState<ImOnboardingPollResult | null>(null);
  const [applyResult, setApplyResult] = useState<ImOnboardingApplyResult | null>(null);
  const appliedFlowRef = useRef<string | null>(null);

  const configured = stateQuery.data?.configured ?? {};
  const existingCredentials = platform === "feishu"
    ? Boolean(configured.FEISHU_APP_ID?.isSet && configured.FEISHU_APP_SECRET?.isSet)
    : Boolean(configured.WEIXIN_ACCOUNT_ID?.isSet && configured.WEIXIN_TOKEN?.isSet);
  const credential = pollResult?.credentialSummary;
  const hasScannedUser = platform === "feishu" ? isSet(credential?.openId) : isSet(credential?.userId);
  const confirmed = pollResult?.status === "confirmed";
  const saved = Boolean(applyResult?.ok) || (existingCredentials && !flow);
  const connected = Boolean(testPlatform.data?.ok || platformQuery.data?.state === "connected");
  const status = pollResult?.status ?? flow?.status;
  const qrData = pollResult?.qrScanData ?? flow?.qrScanData;
  const busy = begin.isPending || poll.isPending || apply.isPending || testPlatform.isPending;
  const terminalQrState = status === "expired" || status === "denied";

  const start = () => {
    begin.reset();
    poll.reset();
    apply.reset();
    testPlatform.reset();
    appliedFlowRef.current = null;
    setFlow(null);
    setPollResult(null);
    setApplyResult(null);
    begin.mutate({ platform, ...(platform === "feishu" ? { domain: "feishu" } : {}) }, {
      onSuccess: setFlow,
    });
  };

  const pollOnce = () => {
    if (!flow?.flowId || poll.isPending) return;
    poll.mutate({ platform, flowId: flow.flowId }, { onSuccess: setPollResult });
  };

  useEffect(() => {
    if (!flow?.flowId || confirmed || terminalQrState) return;
    const delay = Math.max(2, flow.intervalSeconds || 5) * 1000;
    const timer = window.setInterval(() => {
      poll.mutate({ platform, flowId: flow.flowId }, { onSuccess: setPollResult });
    }, delay);
    return () => window.clearInterval(timer);
  }, [confirmed, flow?.flowId, flow?.intervalSeconds, platform, terminalQrState]);

  useEffect(() => {
    const flowId = confirmed ? flow?.flowId : null;
    if (!flowId || appliedFlowRef.current === flowId) return;
    appliedFlowRef.current = flowId;
    apply.mutate({
      platform,
      flowId,
      settings: defaultSettings(platform, hasScannedUser),
      restartGateway: true,
    }, {
      onSuccess: setApplyResult,
      onError: () => { appliedFlowRef.current = null; },
    });
  }, [confirmed, flow?.flowId, hasScannedUser, platform]);

  const checkedFailure = testPlatform.data && !testPlatform.data.ok ? testPlatform.data : null;
  const actionError = errorText(begin.error || poll.error || stateQuery.error);
  const qrMessage = pollResult?.message ?? flow?.message;

  return (
    <SectionShell title={`助理 · ${copy.name}`} sub="扫码接入">
      <div className={s.pageWrap}>
        {showBackLink ? <Link className={s.backLink} to="/assistant"><ArrowLeft size={15} />全部平台</Link> : null}
        <header className={s.connectorHeader}>
          <span className={s.platformIcon}><Icon size={24} /></span>
          <div><span className={s.eyebrow}>{copy.eyebrow}</span><h1>{copy.name}接入</h1><p>{copy.detail}</p></div>
          <ConnectionState connected={connected} configured={saved} />
        </header>

        <ProgressSteps hasCredentials={confirmed || saved} saved={saved} connected={connected} />

        <section className={s.setupPanel}>
          {!flow && !applyResult ? (
            <div className={s.startState}>
              <div>
                <h2>{existingCredentials ? "接入信息已保存" : `用${copy.name}扫码接入`}</h2>
                <p>{existingCredentials ? `可以直接检查${copy.name}连接，或重新扫码更新接入信息。` : copy.qrHint}</p>
              </div>
              <div className={s.actions}>
                {existingCredentials ? <Button kind="primary" onClick={() => testPlatform.mutate()} disabled={busy}><RefreshCw size={15} />检查连接</Button> : null}
                <Button kind={existingCredentials ? "secondary" : "primary"} onClick={start} disabled={busy}><ScanLine size={15} />{existingCredentials ? "重新扫码" : "生成二维码"}</Button>
              </div>
            </div>
          ) : null}

          {flow && !confirmed ? (
            <div className={s.qrState}>
              <QrCode value={qrData} label={copy.name} />
              <div className={s.qrCopy}>
                <span className={s.eyebrow}>SCAN TO CONNECT</span>
                <h2>{copy.qrHint}</h2>
                <p>{qrMessage || "确认后会自动保存，不需要填写其他设置。"}</p>
                <span className={s.qrStatus} data-tone={terminalQrState ? "error" : "pending"}>
                  {terminalQrState ? <CircleAlert size={15} /> : <LoaderCircle className={s.spin} size={15} />}
                  {statusText(status)}
                </span>
                <div className={s.actions}>
                  <Button onClick={pollOnce} disabled={busy || terminalQrState}><RotateCw size={15} />立即检查</Button>
                  {terminalQrState ? <Button kind="primary" onClick={start} disabled={busy}><RefreshCw size={15} />重新生成</Button> : null}
                </div>
              </div>
            </div>
          ) : null}

          {confirmed && (apply.isPending || (!applyResult && !apply.error)) ? (
            <div className={s.savingState}>
              <LoaderCircle className={s.spin} size={24} />
              <div><h2>正在完成接入</h2><p>扫码已确认，正在保存接入信息并启动连接。</p></div>
            </div>
          ) : null}

          {confirmed && apply.error ? (
            <div className={s.completeState}>
              <CircleAlert size={24} />
              <div>
                <h2>接入信息保存失败</h2>
                <p>{errorText(apply.error)}</p>
                <div className={s.actions}><Button kind="primary" onClick={start}><ScanLine size={15} />重新扫码</Button></div>
              </div>
            </div>
          ) : null}

          {applyResult ? (
            <div className={s.completeState} data-ok={applyResult.restart.ok ? "true" : undefined}>
              {applyResult.restart.ok ? <CheckCircle2 size={24} /> : <CircleAlert size={24} />}
              <div>
                <h2>{applyResult.restart.ok ? "扫码信息已保存" : "信息已保存，连接启动失败"}</h2>
                <p>{applyResult.restart.ok ? `点击检查连接，确认 Hermes 已经连上${copy.name}。` : applyResult.restart.message}</p>
                <div className={s.actions}>
                  <Button kind="primary" onClick={() => testPlatform.mutate()} disabled={busy}>
                    {testPlatform.isPending ? <LoaderCircle className={s.spin} size={15} /> : <RefreshCw size={15} />}
                    {testPlatform.isPending ? "正在检查" : "检查连接"}
                  </Button>
                  <Button onClick={start} disabled={busy}><ScanLine size={15} />重新扫码</Button>
                </div>
              </div>
            </div>
          ) : null}
        </section>

        {testPlatform.data?.ok ? (
          <div className={s.successMessage} role="status"><CheckCircle2 size={18} /><div><b>{copy.name}已连接</b><span>现在可以打开{copy.name}，给 Hermes 发一条私聊消息。</span></div></div>
        ) : null}

        {shouldShowFeishuRecovery(platform, checkedFailure) && checkedFailure ? <FeishuFailureHelp result={checkedFailure} /> : null}
        {checkedFailure && platform === "weixin" ? <WeixinFailureHelp result={checkedFailure} onRestart={start} /> : null}
        {actionError ? <div className={s.errorMessage} role="alert"><CircleAlert size={17} /><span>{actionError}</span></div> : null}
      </div>
    </SectionShell>
  );
}

export function ImOnboardingRoute() {
  const { pathname } = useLocation();
  const section = sectionFromPath(pathname);
  if (!section) return <Navigate to="/assistant" replace />;
  if (section === "overview") return <OverviewRoute />;
  if (section === "feishu" || section === "weixin") return <ConnectorRoute key={section} platform={section} />;
  return <Navigate to="/assistant" replace />;
}

export function FeishuRoute() {
  return <ConnectorRoute platform="feishu" showBackLink={false} />;
}

export function WeixinRoute() {
  return <ConnectorRoute platform="weixin" showBackLink={false} />;
}
