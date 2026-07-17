import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import QRCode from "qrcode";
import {
  BadgeInfo,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  KeyRound,
  ListChecks,
  MessageSquareText,
  RefreshCw,
  RotateCw,
  Save,
  ScanLine,
  ShieldCheck,
  Stethoscope,
  X,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type {
  ImOnboardingApplyResult,
  ImOnboardingBeginResult,
  ImOnboardingPollResult,
  ImPlatform,
  ImRedactedValue,
  MessagingPlatformInfo,
  MessagingPlatformTestResponse,
} from "@hermes/protocol";
import { useStatus } from "@/hooks/use-status";
import { CopyButton } from "@/components/ui/copy-button";
import {
  useApplyImOnboarding,
  useBeginImOnboarding,
  useImOnboardingState,
  useMessagingPlatform,
  usePollImOnboarding,
  useTestMessagingPlatform,
} from "@/hooks/use-im-onboarding";
import { useCreateAndSendSession } from "@/hooks/use-create-and-send-session";
import { openExternalUrl } from "@/lib/external-links";
import {
  buildImDiagnosticBundle,
  buildImDiagnosticPrompt,
  type ImDiagnosticBundle,
} from "@/lib/im-onboarding-diagnostics";
import { SectionShell } from "./section-shell";
import s from "./im-onboarding.module.css";

type ImSection = "feishu" | "weixin";
type DmPolicy = "scanned" | "pairing" | "allowlist" | "open" | "disabled";

const FEISHU_DEVELOPER_URL = "https://open.feishu.cn/app";
const FEISHU_SCANNED_OPEN_ID_TOKEN = "__HERMES_SCANNED_FEISHU_OPEN_ID__";
const WEIXIN_SCANNED_USER_ID_TOKEN = "__HERMES_SCANNED_WEIXIN_USER_ID__";
export const FEISHU_REQUIRED_SCOPES = [
  "im:message.p2p_msg:readonly",
  "im:message:send_as_bot",
] as const;
export const FEISHU_GROUP_SCOPE = "im:message.group_at_msg:readonly";
export const FEISHU_RECOMMENDED_SCOPES = [
  "im:resource",
  "cardkit:card:write",
  "cardkit:card:read",
] as const;
const FEISHU_RECEIVE_EVENT = "im.message.receive_v1";

export function sectionFromPath(pathname: string): ImSection | null {
  if (pathname === "/im" || pathname === "/im/") return "feishu";
  if (pathname === "/im/feishu") return "feishu";
  if (pathname === "/im/weixin") return "weixin";
  return null;
}

function last(value?: ImRedactedValue | null): string {
  return value?.redactedValue ?? "未设置";
}

function isSet(value?: ImRedactedValue | null): value is ImRedactedValue {
  return Boolean(value?.isSet);
}

function splitAllowedUsers(value: string): string[] {
  return value
    .split(/[,，\s]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactList(items: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.join(",");
}

export function statusText(status?: string): string {
  switch (status) {
    case "confirmed": return "已确认";
    case "scanned": return "已扫码";
    case "expired_refreshed": return "已刷新";
    case "expired": return "已过期";
    case "denied": return "已拒绝";
    case "pending": return "等待中";
    default: return status || "待开始";
  }
}

function platformState(statusData: ReturnType<typeof useStatus>["data"], platform: ImPlatform) {
  return statusData?.gateway_platforms?.[platform];
}

function textFromError(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function openExternal(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return;
  void openExternalUrl(trimmed);
}

function QrPanel({ data, url, status, message, onStart, startLabel, startBusy }: {
  data?: string | null;
  url?: string | null;
  status?: string;
  message?: string | null;
  onStart?: () => void;
  startLabel?: string;
  startBusy?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    if (!data) return;
    QRCode.toDataURL(data, {
      width: 232,
      margin: 1,
      errorCorrectionLevel: "M",
    }).then((next) => {
      if (!cancelled) setSrc(next);
    }).catch(() => {
      if (!cancelled) setSrc(null);
    });
    return () => { cancelled = true; };
  }, [data]);

  const copy = () => {
    if (data) void navigator.clipboard?.writeText(data);
  };

  return (
    <section className={`${s.section} ${s.qrSection}`}>
      <div className={s.qrBox} aria-label="二维码区域">
        {src ? (
          <img src={src} alt="扫码接入二维码" />
        ) : (
          <div className={s.qrPlaceholder}>
            <span>QR</span>
            {onStart ? (
              <button className={`${s.btn} ${s.primary} ${s.qrStartBtn}`} type="button" onClick={onStart} disabled={startBusy}>
                <ScanLine size={14} />{startBusy ? "生成中…" : startLabel ?? "开始扫码"}
              </button>
            ) : null}
          </div>
        )}
      </div>
      <div className={s.qrCopy}>
        <div className={s.miniEyebrow}>QR ONBOARDING</div>
        <h3>用手机扫一下</h3>
        <p>{message || "二维码生成后，打开对应 App 扫码确认，桌面端会自动继续下一步。"}</p>
        <div className={s.traceRow}><span>状态</span><b>{statusText(status)}</b><em>{data ? "二维码只在本页临时使用" : "还没有生成二维码"}</em></div>
        {url && <code className={s.urlPreview}>{url}</code>}
        <div className={s.buttonRow}>
          <button className={s.btn} type="button" onClick={copy} disabled={!data}><ClipboardList size={14} />复制二维码内容</button>
          {url && <button className={s.btn} type="button" onClick={() => openExternal(url)}><ExternalLink size={14} />打开备用链接</button>}
        </div>
      </div>
    </section>
  );
}

function Hero({ platform, stateSub, onPrimary, primaryBusy }: {
  platform: ImPlatform;
  stateSub: string;
  onPrimary: () => void;
  primaryBusy?: boolean;
}) {
  const isFeishu = platform === "feishu";
  return (
    <div className={s.headBand}>
      <div className={s.heroCopy}>
        <div className={s.heroKicker}><span>{isFeishu ? "№ 031A" : "№ 031B"}</span><span>IM ONBOARDING</span><em>消息接入 / 消息平台接入 / {isFeishu ? "飞书 · Lark" : "微信 · Weixin"}</em></div>
        <h1>将<em>{isFeishu ? "飞书消息平台" : "微信消息平台"}</em>接入<br />中文社区桌面版</h1>
        <p className={s.sub}>{isFeishu
          ? "跟着向导扫码，保存后再按提示到飞书后台勾选权限并发布即可。"
          : "跟着向导用微信扫码确认，桌面端会保存接入账号并自动接收新消息。"}</p>
      </div>
      <div className={s.heroActions}>
        <span className={s.heroState}>{stateSub}</span>
        <button className={`${s.btn} ${s.primary}`} type="button" onClick={onPrimary} disabled={primaryBusy}>
          {isFeishu ? <ScanLine size={14} /> : <MessageSquareText size={14} />}
          {primaryBusy ? "处理中…" : "开始扫码"}
        </button>
      </div>
    </div>
  );
}

function ActionFeedback({ busy, error, flow, status, onJump }: {
  busy: boolean;
  error: unknown;
  flow: ImOnboardingBeginResult | null;
  status?: string;
  onJump?: () => void;
}) {
  const message = textFromError(error);
  if (!busy && !message && !flow) return null;
  const tone = message ? "error" : flow ? "ok" : "info";
  return (
    <div className={s.actionFeedback} data-tone={tone} role={message ? "alert" : "status"}>
      <div>
        <b>{message ? "开始接入失败" : busy ? "正在准备二维码" : "二维码准备好了"}</b>
        <span>{message || (busy ? "桌面端正在准备二维码，请稍等。" : `状态：${statusText(status ?? flow?.status)}。请到扫码区域继续操作。`)}</span>
      </div>
      {flow && !message ? <button className={s.inlineBtn} type="button" onClick={onJump}>查看二维码</button> : null}
    </div>
  );
}

function MetaStrip({ platform, profile, statusData, configured }: {
  platform: ImPlatform;
  profile: string;
  statusData: ReturnType<typeof useStatus>["data"];
  configured: Record<string, ImRedactedValue>;
}) {
  const runtime = platformState(statusData, platform);
  const connectionLabel = platform === "feishu"
    ? "长连接"
    : "自动轮询";
  const credentialSet = platform === "feishu"
    ? Boolean(configured.FEISHU_APP_ID?.isSet && configured.FEISHU_APP_SECRET?.isSet)
    : Boolean(configured.WEIXIN_ACCOUNT_ID?.isSet && configured.WEIXIN_TOKEN?.isSet);
  return (
    <div className={s.metaStrip}>
      <div><span>连接方式</span><b>{connectionLabel}</b></div>
      <div><span>档案</span><b>{profile || "default"}</b></div>
      <div><span>网关</span><b data-tone={statusData?.gateway_running ? "ok" : "warn"}>{statusData?.gateway_running ? "已运行" : "未运行"}</b></div>
      <div><span>密钥</span><b data-tone={credentialSet ? "ok" : "warn"}>{credentialSet ? "已保存" : "未保存"}</b></div>
      <div><span>平台连接</span><b data-tone={runtime?.state === "connected" ? "ok" : undefined}>{runtime?.state === "connected" ? "已连接" : "待连接"}</b></div>
    </div>
  );
}

function FlowSteps({ platform, status, saved }: { platform: ImPlatform; status?: string; saved: boolean }) {
  const scanned = status === "scanned" || status === "confirmed";
  const confirmed = status === "confirmed";
  const labels = platform === "feishu"
    ? [["扫码绑定", "用手机确认"], ["保存设置", "保存到当前档案"], ["打开权限", "按提示勾选发布"], ["试发消息", "私聊验证"]]
    : [["环境检查", "确认能启动"], ["扫码绑定", "用微信确认"], ["访问范围", "设置可用用户"], ["保存验证", "重启后自动检查"]];
  const states = platform === "feishu"
    ? [scanned || confirmed, saved, false, false]
    : [true, scanned || confirmed, confirmed, saved];
  return (
    <div className={s.flowSteps} aria-label="消息平台接入步骤">
      {labels.map(([label, sub], index) => (
        <div key={label} className={s.step} data-done={states[index] ? "true" : undefined} data-active={!states[index] ? "true" : undefined}>
          <span>{states[index] ? "✓" : index + 1}</span><b>{label}</b><em>{sub}</em>
        </div>
      ))}
    </div>
  );
}

function SectionTitle({ num, title, meta }: { num: string; title: string; meta: string }) {
  return <div className={s.sectionTitle}><span>{num}</span><h2>{title}</h2><em>{meta}</em></div>;
}

function ChoiceCard({ active, icon, badge, title, desc, foot, onClick }: {
  active?: boolean;
  icon: "scan" | "key";
  badge: string;
  title: string;
  desc: string;
  foot: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={s.choiceCard} data-active={active ? "true" : undefined} onClick={onClick}>
      <div className={s.choiceTop}><span className={s.choiceIcon}>{icon === "scan" ? <ScanLine size={20} /> : <KeyRound size={20} />}</span><span className={s.pill}>{badge}</span></div>
      <h3>{title}</h3>
      <p>{desc}</p>
      <small>{foot}</small>
    </button>
  );
}

function PolicyCard({ active, warning, title, desc, onClick }: { active?: boolean; warning?: boolean; title: string; desc: string; onClick: () => void }) {
  return (
    <button type="button" className={s.policyCard} data-active={active ? "true" : undefined} data-warning={warning ? "true" : undefined} onClick={onClick}>
      <span>{active ? "✓" : warning ? "!" : "○"}</span>
      <h3>{title}</h3>
      <p>{desc}</p>
    </button>
  );
}

function Field({ label, desc, meta, children }: { label: string; desc: string; meta: string; children: ReactNode }) {
  return (
    <label className={s.field}>
      <span className={s.fieldLabel}><b>{label}</b><small>{desc}</small></span>
      <span className={s.fieldControl}>{children}</span>
      <code>{meta}</code>
    </label>
  );
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value);
}

function FeishuBackendChecklist({ groupEnabled }: { groupEnabled: boolean }) {
  const requiredScopeList = [
    ...FEISHU_REQUIRED_SCOPES,
    ...(groupEnabled ? [FEISHU_GROUP_SCOPE] : []),
  ];
  const requiredScopes = requiredScopeList.join("\n");
  const recommendedScopes = FEISHU_RECOMMENDED_SCOPES.join("\n");
  const importJson = JSON.stringify({
    scopes: {
      tenant: [...requiredScopeList, ...FEISHU_RECOMMENDED_SCOPES],
    },
  }, null, 2);

  return (
    <section className={`${s.section} ${s.backendChecklist}`}>
      <div className={s.checkIntro}>
        <div>
          <div className={s.miniEyebrow}>FEISHU CONSOLE</div>
          <h3>飞书后台还要点几下</h3>
          <p>{groupEnabled
            ? "扫码只是把应用信息带回来。你已打开群聊高级选项，所以除了私聊权限，还要补上群聊 @ 消息权限，最后发布一次版本。"
            : "扫码只是把应用信息带回来。还要在飞书后台打开机器人、订阅消息事件、开启发送权限，最后发布一次版本，私聊才能用。"}</p>
        </div>
        <button className={`${s.btn} ${s.externalBtn}`} type="button" onClick={() => openExternal(FEISHU_DEVELOPER_URL)}>
          <ExternalLink size={14} />打开飞书开发者后台
        </button>
      </div>

      <div className={s.consoleSteps}>
        <div className={s.consoleStep}>
          <span>1</span>
          <b>先点上面的保存</b>
          <p>保存后桌面端会启动网关，飞书才能把消息发送过来。</p>
        </div>
        <div className={s.consoleStep}>
          <span>2</span>
          <b>订阅接收消息</b>
          <p>在「事件与回调」里选择长连接接收事件，然后添加「接收消息 v2.0」。{groupEnabled ? "群聊场景也需要在消息权限里勾选群聊 @ 消息。" : ""}</p>
          <code>{FEISHU_RECEIVE_EVENT}</code>
        </div>
        <div className={s.consoleStep}>
          <span>3</span>
          <b>开权限并发布</b>
          <p>权限加完以后记得创建版本并发布，否则飞书里看起来就像机器人没反应。</p>
        </div>
      </div>

      <div className={s.scopeGrid}>
        <div className={s.scopeBox}>
          <div className={s.scopeHead}><b>当前必须权限</b><button type="button" onClick={() => copyText(requiredScopes)}>复制</button></div>
          {requiredScopeList.map((scope) => <code key={scope}>{scope}</code>)}
          {!groupEnabled ? <small className={s.scopeNote}>默认只开通私聊；需要群聊时再到高级设置打开。</small> : null}
        </div>
        <div className={s.scopeBox}>
          <div className={s.scopeHead}><b>按需推荐</b><button type="button" onClick={() => copyText(recommendedScopes)}>复制</button></div>
          {FEISHU_RECOMMENDED_SCOPES.map((scope) => <code key={scope}>{scope}</code>)}
        </div>
      </div>

      <div className={s.importBox}>
        <div className={s.scopeHead}><b>权限导入 JSON</b><button type="button" onClick={() => copyText(importJson)}>复制 JSON</button></div>
        <pre>{importJson}</pre>
      </div>
    </section>
  );
}

function platformStateText(state?: string | null): string {
  switch (state) {
    case "connected": return "已连接";
    case "disabled": return "未启用";
    case "not_configured": return "配置不完整";
    case "pending_restart": return "等待重启";
    case "gateway_stopped": return "网关未运行";
    case "error": return "连接错误";
    default: return state || "暂无状态";
  }
}


function DiagnosticAssistant({
  bundle,
  onAskHermes,
  asking,
  askError,
}: {
  bundle: ImDiagnosticBundle;
  onAskHermes: () => void;
  asking: boolean;
  askError?: string | null;
}) {
  const shownIssues = bundle.issues.slice(0, 3);
  const hasIssue = bundle.issues.some((issue) => issue.level !== "ok");
  return (
    <div className={s.diagnosticAssistant}>
      <div className={s.diagnosticHead}>
        <div>
          <div className={s.miniEyebrow}>HERMES CHECK</div>
          <h4>{hasIssue ? "接入失败时，让 Hermes 帮你排查" : "接入已就绪，可按需继续检查"}</h4>
          <p>{hasIssue ? "这里会汇总当前配置、网关状态、检测结果和最近一次扫码/保存情况，不含密钥明文。" : "当前状态没有明显问题；如果之后收不到回复，可以复制诊断信息继续排查。"}</p>
        </div>
        <div className={s.diagnosticActions}>
          <CopyButton className={s.btn} text={() => JSON.stringify(bundle, null, 2)}>
            <ClipboardList size={14} />复制诊断包
          </CopyButton>
          <CopyButton className={s.btn} text={() => buildImDiagnosticPrompt(bundle)}>
            <ClipboardList size={14} />复制排查提示
          </CopyButton>
          <button className={`${s.btn} ${s.primary}`} type="button" onClick={onAskHermes} disabled={asking}>
            <MessageSquareText size={14} />{asking ? "正在打开…" : "让 Hermes 排查"}
          </button>
        </div>
      </div>
      <div className={s.issueGrid}>
        {shownIssues.map((issue) => (
          <div className={s.issueCard} data-tone={issue.level} key={`${issue.level}-${issue.title}`}>
            <b>{issue.title}</b>
            <span>{issue.detail}</span>
            <em>{issue.nextStep}</em>
          </div>
        ))}
      </div>
      {askError ? <div className={s.inlineError}><XCircle size={14} />{askError}</div> : null}
    </div>
  );
}

function MessagingTestGuide({
  result,
  platform,
  platformLoading,
  testResult,
  testError,
  testPending,
  onTest,
  platformLabel,
  readyCopy,
  notReadyCopy,
}: {
  result: ImOnboardingApplyResult | null;
  platform?: MessagingPlatformInfo | null;
  platformLoading: boolean;
  testResult?: MessagingPlatformTestResponse | null;
  testError?: unknown;
  testPending: boolean;
  onTest: () => void;
  platformLabel: string;
  readyCopy?: string;
  notReadyCopy?: string;
}) {
  const restartOk = Boolean(result?.restart.ok);
  const connected = platform?.state === "connected";
  const officialAvailable = platform !== null && platform !== undefined;
  const testMessage = testResult?.message ?? textFromError(testError);
  const platformStatus = platformLoading
    ? "读取中…"
    : officialAvailable
      ? platformStateText(platform?.state)
      : "旧版本内核未提供";
  return (
    <section className={`${s.section} ${s.testGuide}`} data-ready={restartOk || connected ? "true" : undefined}>
      <div className={s.testIntro}>
        <div className={s.miniEyebrow}>LIVE TEST</div>
        <h3>最后发消息试一下</h3>
        <p>{restartOk
          ? readyCopy ?? `网关已经按当前档案重启。先点一次检测确认连接，再去${platformLabel}里私聊机器人发送 hi。`
          : notReadyCopy ?? `先保存、完成${platformLabel}后台设置，再回来私聊机器人验证。`}</p>
      </div>

      <div className={s.testPanel}>
        <div className={s.testCards}>
          <div><MessageSquareText size={15} /><b>私聊测试</b><span>给机器人发送 <code>hi</code>，应收到回复或配对提示。</span></div>
          <div><Stethoscope size={15} /><b>官方检测</b><span>{platformLoading
            ? "正在读取官方消息平台状态。"
            : officialAvailable
              ? `当前状态：${platformStateText(platform?.state)}${platform?.error_message ? `，${platform.error_message}` : ""}`
              : "当前内核版本暂不支持官方平台检测，已改用网关状态判断。"}</span></div>
        </div>

        <div className={s.statusGrid}>
          <div className={s.statusItem} data-tone={restartOk ? "ok" : "warn"}><b>保存重启</b><span>{restartOk ? result?.restart.message || "已完成" : "还没有成功保存并重启"}</span></div>
          <div className={s.statusItem} data-tone={connected ? "ok" : undefined}><b>平台状态</b><span>{platformStatus}</span></div>
          <div className={s.statusItem} data-tone={testResult?.ok ? "ok" : testResult ? "warn" : undefined}><b>检测结果</b><span>{testPending ? "检测中…" : testMessage || "可点击检测缺口"}</span></div>
        </div>

        <div className={s.testActions}>
          <button className={s.btn} type="button" onClick={onTest} disabled={platformLoading || testPending}>
            <RotateCw size={14} />{testPending ? "检测中…" : `检测${platformLabel}连接`}
          </button>
        </div>
      </div>
    </section>
  );
}

type RailPanelId = "check" | "why" | "diagnosis";

interface RailPanelSection {
  title: string;
  body?: string;
  items?: string[];
  chips?: string[];
  tone?: "ok" | "warn";
}

interface RailPanelConfig {
  id: RailPanelId;
  icon: LucideIcon;
  label: string;
  tone: "ok" | "accent" | "warn";
  eyebrow: string;
  title: string;
  summary: string;
  sections: RailPanelSection[];
}

export function railPanels(platform: ImPlatform): RailPanelConfig[] {
  if (platform === "feishu") {
    return [
      {
        id: "check",
        icon: ListChecks,
        label: "检查",
        tone: "ok",
        eyebrow: "CHECKLIST",
        title: "飞书后台检查清单",
        summary: "扫码只完成第一步。要能聊天，还要保存设置、打开飞书后台的消息权限，并发布应用。",
        sections: [
          {
            title: "私聊必备",
            items: ["已把允许对话的用户加入名单", "已打开机器人", "已订阅消息事件", `事件里包含 ${FEISHU_RECEIVE_EVENT}`, "应用已创建版本并发布"],
          },
          {
            title: "必须权限",
            items: Array.from(FEISHU_REQUIRED_SCOPES),
            chips: ["单聊可收", "机器人可发"],
          },
          {
            title: "群聊可选",
            items: [`需要群聊 @ 回复时，再打开高级设置并补充 ${FEISHU_GROUP_SCOPE}`, "默认先完成私聊，少申请一个权限，更容易排查问题"],
          },
        ],
      },
      {
        id: "why",
        icon: Zap,
        label: "推荐",
        tone: "accent",
        eyebrow: "WHY WS",
        title: "为什么默认用长连接",
        summary: "无需准备公网地址或内网穿透，桌面端会自动和飞书保持连接。",
        sections: [
          {
            title: "产品默认",
            body: "长连接会由桌面端和飞书后台建立。你仍然需要在飞书后台添加接收消息事件并发布应用，消息才会真正送到本机。",
            chips: ["无需公网 IP", "适合桌面端", "链路更稳定"],
          },
          {
            title: "何时用回调模式",
            items: ["公司已经有统一回调入口", "需要集中审计所有开放平台事件", "已经准备好可访问的公网域名"],
          },
        ],
      },
      {
        id: "diagnosis",
        icon: Stethoscope,
        label: "诊断",
        tone: "warn",
        eyebrow: "DIAGNOSIS",
        title: "常见失败诊断",
        summary: "这里只看配置缺口和常见原因，不显示密钥或 token 原文。",
        sections: [
          {
            title: "快速排查",
            items: ["私聊没反应：确认已开通私聊消息权限并发布", "能收不能发：确认已开通机器人发送消息权限", "事件日志为空：确认已订阅接收消息 v2.0 并发布版本"],
          },
          {
            title: "日志关键词",
            chips: ["飞书连接状态", "事件订阅", "机器人未启用"],
          },
        ],
      },
    ];
  }

  return [
    {
      id: "check",
      icon: BadgeInfo,
      label: "接入",
      tone: "accent",
      eyebrow: "WEIXIN",
      title: "这是微信消息平台接入",
      summary: "这里接的是微信消息平台，不是企业微信或公众号后台。",
      sections: [
        {
          title: "接入边界",
          items: ["扫码获取微信接入账号和口令", "桌面端会定时拉取新消息", "图片和文件走单独的媒体地址"],
        },
        {
          title: "安全默认",
          body: "账号和口令只保存到当前配置档案，页面摘要会自动隐藏。",
          chips: ["非企微", "非公众号"],
        },
      ],
    },
    {
      id: "diagnosis",
      icon: Stethoscope,
      label: "诊断",
      tone: "warn",
      eyebrow: "DIAGNOSIS",
      title: "常见失败诊断",
      summary: "这里只显示组件、接收状态和配置缺口，不显示口令原文。",
      sections: [
        {
          title: "快速排查",
          items: ["提示组件缺失：重新安装或更新桌面端", "提示未绑定：重新扫码或手动恢复账号", "提示已被占用：先停止另一个网关"],
        },
        {
          title: "日志关键词",
          chips: ["微信连接状态", "消息拉取", "网关占用"],
        },
      ],
    },
  ];
}

function Rail({ platform }: { platform: ImPlatform }) {
  const [active, setActive] = useState<RailPanelId | null>(null);
  const panels = railPanels(platform);
  const activePanel = panels.find((panel) => panel.id === active) ?? null;

  return (
    <div className={s.contextRail} data-open={activePanel ? "true" : undefined}>
      <div className={s.railTrack} aria-label={`${platform === "feishu" ? "飞书" : "微信"}接入上下文`}>
        {panels.map((panel) => {
          const Icon = panel.icon;
          const isActive = active === panel.id;
          return (
            <button
              key={panel.id}
              type="button"
              className={s.railTrigger}
              data-active={isActive ? "true" : undefined}
              data-tone={panel.tone}
              aria-expanded={isActive}
              aria-controls={`${platform}-${panel.id}-panel`}
              onClick={() => setActive(isActive ? null : panel.id)}
            >
              <Icon size={17} aria-hidden="true" />
              <span className={s.railLabel}>{panel.label}</span>
              <span className={s.railDot} aria-hidden="true" />
            </button>
          );
        })}
      </div>

      {activePanel ? (
        <div className={s.contextPopover} role="dialog" aria-label={activePanel.title}>
          <button className={s.railClose} type="button" onClick={() => setActive(null)}>
            <X size={14} aria-hidden="true" />
            收起
          </button>
          <section id={`${platform}-${activePanel.id}-panel`} className={s.railPanel}>
            <div className={s.railPanelEyebrow}>{activePanel.eyebrow}</div>
            <h3>{activePanel.title}</h3>
            <p>{activePanel.summary}</p>
            {activePanel.sections.map((section) => (
              <div className={s.railPanelSection} data-tone={section.tone} key={section.title}>
                <b>{section.title}</b>
                {section.body ? <span>{section.body}</span> : null}
                {section.items ? (
                  <ul className={s.compactList}>
                    {section.items.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                ) : null}
                {section.chips ? (
                  <div className={s.railChips}>
                    {section.chips.map((chip) => <em key={chip}>{chip}</em>)}
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function ReviewTable({ rows }: { rows: Array<[string, string, string]> }) {
  return (
    <section className={`${s.section} ${s.reviewSection}`}>
      <table className={s.reviewTable}>
        <thead><tr><th>产品项</th><th>将写入的配置</th><th>状态</th></tr></thead>
        <tbody>{rows.map(([a, b, c]) => <tr key={a}><td>{a}</td><td><code>{b}</code></td><td>{c}</td></tr>)}</tbody>
      </table>
    </section>
  );
}

function ApplyResult({ result }: { result: ImOnboardingApplyResult | null }) {
  if (!result) return null;
  const Icon = result.restart.ok ? CheckCircle2 : XCircle;
  return (
    <div className={s.resultBox} data-ok={result.restart.ok ? "true" : undefined}>
      <Icon size={16} />
      <div>
        <b>配置已保存到当前档案：{result.currentProfile}</b>
        <span>配置文件：<code>{result.envPath}</code>{result.backupPath ? <> · 备份：<code>{result.backupPath}</code></> : null}</span>
        <span>{result.restart.message}</span>
      </div>
    </div>
  );
}

function FeishuRoute() {
  const stateQuery = useImOnboardingState("feishu");
  const statusQuery = useStatus();
  const begin = useBeginImOnboarding();
  const poll = usePollImOnboarding();
  const apply = useApplyImOnboarding("feishu");
  const messagingPlatformQuery = useMessagingPlatform("feishu");
  const testPlatform = useTestMessagingPlatform("feishu");
  const createAndSendSession = useCreateAndSendSession();
  const domain = "feishu";
  const connectionMode = "websocket";
  const [dmPolicy, setDmPolicy] = useState<DmPolicy>("pairing");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [includeScannedOpenId, setIncludeScannedOpenId] = useState(true);
  const [groupEnabled, setGroupEnabled] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [homeChannel, setHomeChannel] = useState("");
  const [flow, setFlow] = useState<ImOnboardingBeginResult | null>(null);
  const [pollResult, setPollResult] = useState<ImOnboardingPollResult | null>(null);
  const [result, setResult] = useState<ImOnboardingApplyResult | null>(null);
  const [diagnosticPending, setDiagnosticPending] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const qrAnchorRef = useRef<HTMLDivElement>(null);

  const configured = stateQuery.data?.configured ?? {};
  const status = pollResult?.status ?? flow?.status;
  const credential = pollResult?.credentialSummary;
  const scannedOpenId = isSet(credential?.openId) ? credential.openId : null;
  const canApplyQr = Boolean(credential && pollResult?.status === "confirmed");
  const busy = begin.isPending || poll.isPending || apply.isPending;
  const jumpToQr = () => qrAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const start = () => {
    begin.reset();
    poll.reset();
    testPlatform.reset();
    setResult(null);
    begin.mutate({ platform: "feishu", domain }, {
      onSuccess: (next) => {
        setFlow(next);
        setPollResult(null);
        window.requestAnimationFrame(jumpToQr);
      },
    });
  };
  const pollOnce = () => {
    const flowId = flow?.flowId;
    if (!flowId) return;
    poll.mutate({ platform: "feishu", flowId }, { onSuccess: setPollResult });
  };
  useEffect(() => {
    if (!flow?.flowId || pollResult?.status === "confirmed" || pollResult?.status === "expired" || pollResult?.status === "denied") return;
    const delay = Math.max(2, flow.intervalSeconds || 5) * 1000;
    const id = window.setInterval(pollOnce, delay);
    return () => window.clearInterval(id);
  }, [flow?.flowId, flow?.intervalSeconds, pollResult?.status]);
  useEffect(() => {
    if (pollResult?.status === "confirmed" && scannedOpenId && dmPolicy === "pairing") {
      setDmPolicy("scanned");
      setIncludeScannedOpenId(true);
    }
  }, [pollResult?.status, scannedOpenId?.fingerprint, dmPolicy]);

  const shouldAutoHomeChannel = Boolean(scannedOpenId) && !homeChannel.trim();
  const settings = () => {
    const allowAll = dmPolicy === "open" ? "true" : "false";
    const useScannedOpenId = Boolean(scannedOpenId) && (dmPolicy === "scanned" || (dmPolicy === "allowlist" && includeScannedOpenId));
    const allowedList = dmPolicy === "scanned" || dmPolicy === "allowlist"
      ? compactList([
        ...(useScannedOpenId ? [FEISHU_SCANNED_OPEN_ID_TOKEN] : []),
        ...splitAllowedUsers(allowedUsers),
      ])
      : "";
    const patch: Record<string, string> = {
      FEISHU_DOMAIN: domain,
      FEISHU_CONNECTION_MODE: connectionMode,
      FEISHU_ALLOW_ALL_USERS: allowAll,
      FEISHU_ALLOWED_USERS: allowedList,
      FEISHU_GROUP_POLICY: groupEnabled ? "open" : "disabled",
      FEISHU_REQUIRE_MENTION: "true",
    };
    if (shouldAutoHomeChannel || homeChannel.trim()) {
      patch.FEISHU_HOME_CHANNEL = shouldAutoHomeChannel ? FEISHU_SCANNED_OPEN_ID_TOKEN : homeChannel.trim();
    }
    return patch;
  };
  const save = () => {
    apply.mutate({
      platform: "feishu",
      flowId: flow?.flowId,
      manualCredentials: undefined,
      settings: settings(),
      restartGateway: true,
    }, { onSuccess: setResult });
  };
  const manualAllowedCount = splitAllowedUsers(allowedUsers).length;
  const useScannedOpenId = Boolean(scannedOpenId) && (dmPolicy === "scanned" || (dmPolicy === "allowlist" && includeScannedOpenId));
  const allowPolicyReady = dmPolicy === "scanned"
    ? Boolean(scannedOpenId)
    : dmPolicy === "allowlist"
      ? Boolean(useScannedOpenId || manualAllowedCount > 0)
      : true;
  const allowlistReview = dmPolicy === "scanned"
    ? `扫码用户 ${last(scannedOpenId)}`
    : dmPolicy === "allowlist"
      ? compactList([
        ...(useScannedOpenId ? [`扫码用户 ${last(scannedOpenId)}`] : []),
        ...(manualAllowedCount > 0 ? [`手动 ${manualAllowedCount} 个`] : []),
      ]) || "未填写"
      : "";
  const allowlistStatus = dmPolicy === "open" ? "未限制" : dmPolicy === "pairing" ? "走配对确认" : allowPolicyReady ? "可保存" : "缺少 open_id";
  const homeChannelReview = shouldAutoHomeChannel ? `扫码用户 ${last(scannedOpenId)}` : homeChannel.trim() || "保持原配置";
  const homeChannelStatus = shouldAutoHomeChannel ? "自动设置" : homeChannel.trim() ? "已填写" : "不改动";
  const rows: Array<[string, string, string]> = [
    ["连接模式", `FEISHU_CONNECTION_MODE=${connectionMode}`, connectionMode === "websocket" ? "推荐" : "高级"],
    ["区域", `FEISHU_DOMAIN=${domain}`, "已选择"],
    ["私聊策略", `FEISHU_ALLOW_ALL_USERS=${dmPolicy === "open" ? "true" : "false"}`, dmPolicy === "scanned" ? "只允许扫码用户" : dmPolicy === "pairing" ? "需要确认" : dmPolicy],
    ["允许对话用户", `FEISHU_ALLOWED_USERS=${allowlistReview}`, allowlistStatus],
    ["群聊入口", `FEISHU_GROUP_POLICY=${groupEnabled ? "open" : "disabled"}`, groupEnabled ? "高级：仅 @ 响应" : "默认关闭"],
    ["默认通知会话", `FEISHU_HOME_CHANNEL=${homeChannelReview}`, homeChannelStatus],
  ];
  const diagnosticBundle = useMemo(() => buildImDiagnosticBundle({
    platform: "feishu",
    currentProfile: stateQuery.data?.currentProfile,
    hermesHome: stateQuery.data?.hermesHome,
    envPath: stateQuery.data?.envPath,
    configured,
    statusData: statusQuery.data,
    platformInfo: messagingPlatformQuery.data,
    testResult: testPlatform.data,
    testError: testPlatform.error,
    applyResult: result,
    beginError: begin.error,
    pollError: poll.error,
    applyError: apply.error,
    stateError: stateQuery.error,
    qrStatus: status,
    qrMessage: pollResult?.message ?? flow?.message,
    credential,
  }), [
    apply.error,
    begin.error,
    configured,
    credential,
    flow?.message,
    messagingPlatformQuery.data,
    poll.error,
    pollResult?.message,
    result,
    stateQuery.data?.currentProfile,
    stateQuery.data?.envPath,
    stateQuery.data?.hermesHome,
    stateQuery.error,
    status,
    statusQuery.data,
    testPlatform.data,
    testPlatform.error,
  ]);
  const askHermesToDiagnose = async () => {
    setDiagnosticError(null);
    setDiagnosticPending(true);
    try {
      await createAndSendSession({
        text: buildImDiagnosticPrompt(diagnosticBundle),
        attachments: [],
      }, { updateAttachment: () => undefined });
    } catch (error) {
      setDiagnosticError(textFromError(error) ?? "无法打开 Hermes 排查会话");
    } finally {
      setDiagnosticPending(false);
    }
  };

  return (
    <SectionShell title="消息平台接入 · 飞书" sub="03 消息接入 / 031 消息平台接入" rail={<Rail platform="feishu" />} railLabel="飞书接入诊断边栏">
      <div className={s.wrap}>
        <main className={s.mainCol}>
          <Hero platform="feishu" stateSub={`当前档案：${stateQuery.data?.currentProfile ?? "default"}`} onPrimary={start} primaryBusy={busy} />
          <ActionFeedback busy={begin.isPending} error={begin.error} flow={flow} status={status} onJump={jumpToQr} />
          <MetaStrip platform="feishu" profile={stateQuery.data?.currentProfile ?? "default"} statusData={statusQuery.data} configured={configured} />
          <FlowSteps platform="feishu" status={status} saved={Boolean(result?.restart.ok)} />
          <div ref={qrAnchorRef} className={s.anchorBlock}>
            <SectionTitle num="[ STEP 01 ]" title="用飞书扫码确认" meta={flow ? `每 ${flow.intervalSeconds} 秒自动检查一次；成功后继续下一步` : "二维码只在当前页面临时使用"} />
            <QrPanel
              data={pollResult?.qrScanData ?? flow?.qrScanData}
              url={pollResult?.qrUrl ?? flow?.qrUrl}
              status={status}
              message={pollResult?.message ?? flow?.message}
              onStart={start}
              startLabel="开始扫码"
              startBusy={begin.isPending}
            />
          </div>
          <div className={s.sectionActions}><button className={`${s.btn} ${s.primary}`} onClick={start} disabled={busy}><ScanLine size={14} />生成二维码</button><button className={s.btn} onClick={pollOnce} disabled={!flow || busy}><RefreshCw size={14} />立即检查</button></div>

          <SectionTitle num="[ STEP 02 ]" title="保存设置并启动网关" meta="只会更新当前配置档案；飞书后台还需要继续按提示确认" />
          <section className={s.section}>
            <div className={s.policyGrid}>
              {scannedOpenId && <PolicyCard active={dmPolicy === "scanned"} title="只允许扫码用户" desc={`把本次扫码用户的 open_id（${last(scannedOpenId)}）写入允许列表。`} onClick={() => setDmPolicy("scanned")} />}
              <PolicyCard active={dmPolicy === "pairing"} title="需要确认再放行" desc="陌生用户先发起申请，管理员同意后可用。" onClick={() => setDmPolicy("pairing")} />
              <PolicyCard active={dmPolicy === "allowlist"} title="只允许指定用户" desc="只让列表里的飞书 open_id 使用，可把扫码用户一起加入。" onClick={() => setDmPolicy("allowlist")} />
              <PolicyCard active={dmPolicy === "open"} warning title="所有私聊都可用" desc="方便试用，但不建议长期开放。" onClick={() => setDmPolicy("open")} />
            </div>
            {scannedOpenId && (dmPolicy === "scanned" || dmPolicy === "allowlist") && (
              <div className={s.identityNote}>
                <b>已拿到扫码用户 open_id</b>
                <span>界面只显示隐藏值 <code>{last(scannedOpenId)}</code>，保存时桌面端会把完整 open_id 写入 <code>FEISHU_ALLOWED_USERS</code>；默认通知会话留空时，也会自动写入 <code>FEISHU_HOME_CHANNEL</code>。</span>
              </div>
            )}
            {dmPolicy === "allowlist" && <>
              {scannedOpenId && (
                <label className={s.checkToggle}>
                  <input type="checkbox" checked={includeScannedOpenId} onChange={(e) => setIncludeScannedOpenId(e.target.checked)} />
                  <span>同时加入本次扫码用户 <code>{last(scannedOpenId)}</code></span>
                </label>
              )}
              <Field label="允许对话用户 open_id" desc={scannedOpenId ? "可继续添加其他飞书用户 open_id；多个值用英文逗号分隔。" : "多个飞书 open_id 用英文逗号分隔；可从飞书消息事件 sender_id.open_id 获取。"} meta="FEISHU_ALLOWED_USERS"><input value={allowedUsers} onChange={(e) => setAllowedUsers(e.target.value)} placeholder="ou_xxx,ou_yyy" /></Field>
            </>}
            <Field label="默认通知会话" desc={scannedOpenId ? "用于定时任务和跨平台通知；留空会自动使用本次扫码用户的私聊。" : "用于定时任务和跨平台通知；扫码成功后会自动填到当前用户，也可以手动填 chat_id。"} meta="FEISHU_HOME_CHANNEL"><input value={homeChannel} onChange={(e) => setHomeChannel(e.target.value)} placeholder={scannedOpenId ? "留空自动使用扫码用户" : "oc_xxx 或留空"} /></Field>
            <div className={s.advancedPanel} data-open={showAdvanced ? "true" : undefined}>
              <button className={s.advancedHeader} type="button" onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced}>
                <span>
                  <b>高级设置</b>
                  <small>默认不需要动；只有要群聊、Lark 国际版或公司统一回调时才展开。</small>
                </span>
                <em>{showAdvanced ? "收起" : "展开"}</em>
              </button>
              {showAdvanced ? (
                <div className={s.advancedBody}>
                  <label className={s.checkToggle}>
                    <input type="checkbox" checked={groupEnabled} onChange={(e) => setGroupEnabled(e.target.checked)} />
                    <span>启用群聊 @ 机器人入口。打开后会写入 <code>FEISHU_GROUP_POLICY=open</code>，并在权限清单里补充 <code>{FEISHU_GROUP_SCOPE}</code>；关闭时保持 <code>disabled</code>。</span>
                  </label>
                  <div className={s.advancedHint}>
                    <b>先别急着开高级项</b>
                    <span>建议先跑通私聊。Webhook、Lark 国际版和已有企业应用的手动密钥仍可在环境变量页配置；这个向导默认采用飞书中国区长连接，避免准备公网回调地址。</span>
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <SectionTitle num="[ REVIEW ]" title="保存前看一眼" meta="密钥会自动隐藏；保存后继续去飞书后台确认" />
          {credential && <div className={s.summaryLine}>扫码结果：应用 ID {last(credential.appId)} · 应用密钥 {last(credential.appSecret)} · 扫码用户 open_id {last(credential.openId)} · 机器人 {credential.botName ?? "未探测"}</div>}
          <ReviewTable rows={rows} />
          <div className={s.sectionActions}><button className={`${s.btn} ${s.primary}`} onClick={save} disabled={busy || !canApplyQr || !allowPolicyReady}><Save size={14} />保存并启动网关</button></div>
          <ApplyResult result={result} />
          <SectionTitle num="[ STEP 03 ]" title="打开飞书后台完成权限" meta="按清单勾选权限、订阅消息并发布版本" />
          <FeishuBackendChecklist groupEnabled={groupEnabled} />
          <SectionTitle num="[ STEP 04 ]" title="发一条消息试试" meta="私聊机器人，确认真的能回复" />
          <MessagingTestGuide
            result={result}
            platform={messagingPlatformQuery.data}
            platformLoading={messagingPlatformQuery.isLoading}
            testResult={testPlatform.data}
            testError={testPlatform.error}
            testPending={testPlatform.isPending}
            onTest={() => testPlatform.mutate()}
            platformLabel="飞书"
            readyCopy="网关已经按当前档案重启。先点一次检测确认连接，再去飞书里私聊机器人发送 hi。"
            notReadyCopy="先保存、完成飞书后台设置并发布，再回来私聊机器人验证。"
          />
          <DiagnosticAssistant
            bundle={diagnosticBundle}
            onAskHermes={askHermesToDiagnose}
            asking={diagnosticPending}
            askError={diagnosticError}
          />
          {(begin.error || poll.error || apply.error || stateQuery.error) && <div className={s.errorBox}><XCircle size={16} />{textFromError(begin.error || poll.error || apply.error || stateQuery.error)}</div>}
        </main>
      </div>
    </SectionShell>
  );
}

function WeixinRoute() {
  const stateQuery = useImOnboardingState("weixin");
  const statusQuery = useStatus();
  const begin = useBeginImOnboarding();
  const poll = usePollImOnboarding();
  const apply = useApplyImOnboarding("weixin");
  const messagingPlatformQuery = useMessagingPlatform("weixin");
  const testPlatform = useTestMessagingPlatform("weixin");
  const createAndSendSession = useCreateAndSendSession();
  const [dmPolicy, setDmPolicy] = useState<DmPolicy>("pairing");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [homeChannel, setHomeChannel] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://ilinkai.weixin.qq.com");
  const [cdnBaseUrl, setCdnBaseUrl] = useState("https://novac2c.cdn.weixin.qq.com/c2c");
  const [flow, setFlow] = useState<ImOnboardingBeginResult | null>(null);
  const [pollResult, setPollResult] = useState<ImOnboardingPollResult | null>(null);
  const [result, setResult] = useState<ImOnboardingApplyResult | null>(null);
  const [diagnosticPending, setDiagnosticPending] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const qrAnchorRef = useRef<HTMLDivElement>(null);
  const configured = stateQuery.data?.configured ?? {};
  const status = pollResult?.status ?? flow?.status;
  const credential = pollResult?.credentialSummary;
  const scannedUserId = isSet(credential?.userId) ? credential.userId : null;
  const busy = begin.isPending || poll.isPending || apply.isPending;
  const canApplyQr = Boolean(credential && pollResult?.status === "confirmed");
  const canApplyManual = Boolean(accountId.trim() && token.trim());
  const canApplySaved = Boolean(configured.WEIXIN_ACCOUNT_ID?.isSet && configured.WEIXIN_TOKEN?.isSet);
  const jumpToQr = () => qrAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const start = () => {
    begin.reset();
    poll.reset();
    testPlatform.reset();
    begin.mutate({ platform: "weixin" }, {
      onSuccess: (next) => {
        setFlow(next);
        setPollResult(null);
        setResult(null);
        window.requestAnimationFrame(jumpToQr);
      },
    });
  };
  const pollOnce = () => {
    if (!flow?.flowId) return;
    poll.mutate({ platform: "weixin", flowId: flow.flowId }, { onSuccess: setPollResult });
  };
  useEffect(() => {
    if (!flow?.flowId || pollResult?.status === "confirmed" || pollResult?.status === "expired") return;
    const id = window.setInterval(pollOnce, 1500);
    return () => window.clearInterval(id);
  }, [flow?.flowId, pollResult?.status]);
  useEffect(() => {
    if (pollResult?.status === "confirmed" && scannedUserId && dmPolicy === "pairing") {
      setDmPolicy("allowlist");
    }
  }, [pollResult?.status, scannedUserId?.fingerprint, dmPolicy]);

  const shouldAutoWeixinHomeChannel = Boolean(scannedUserId) && !homeChannel.trim();
  const useScannedUserId = Boolean(scannedUserId) && dmPolicy === "allowlist";
  const manualAllowedCount = splitAllowedUsers(allowedUsers).length;
  const allowPolicyReady = dmPolicy === "open" || dmPolicy === "pairing" || Boolean(useScannedUserId || manualAllowedCount > 0);
  const dmPolicyValue = dmPolicy === "open" ? "open" : dmPolicy === "pairing" ? "pairing" : "allowlist";
  const settings = () => {
    const patch: Record<string, string> = {
      WEIXIN_BASE_URL: baseUrl.trim().replace(/\/$/, ""),
      WEIXIN_CDN_BASE_URL: cdnBaseUrl.trim().replace(/\/$/, ""),
      WEIXIN_DM_POLICY: dmPolicyValue,
      WEIXIN_ALLOW_ALL_USERS: dmPolicy === "open" ? "true" : "false",
      WEIXIN_GROUP_POLICY: "disabled",
      WEIXIN_GROUP_ALLOWED_USERS: "",
    };
    if (dmPolicy === "allowlist") {
      patch.WEIXIN_ALLOWED_USERS = compactList([
        ...(useScannedUserId ? [WEIXIN_SCANNED_USER_ID_TOKEN] : []),
        ...splitAllowedUsers(allowedUsers),
      ]);
    } else {
      patch.WEIXIN_ALLOWED_USERS = "";
    }
    if (shouldAutoWeixinHomeChannel || homeChannel.trim()) {
      patch.WEIXIN_HOME_CHANNEL = shouldAutoWeixinHomeChannel ? WEIXIN_SCANNED_USER_ID_TOKEN : homeChannel.trim();
    }
    return patch;
  };
  const save = () => {
    const useSavedCredentials = !canApplyQr && !canApplyManual && canApplySaved;
    apply.mutate({
      platform: "weixin",
      flowId: flow?.flowId,
      manualCredentials: canApplyQr || useSavedCredentials ? undefined : { accountId, token, baseUrl },
      settings: useSavedCredentials ? {} : settings(),
      restartGateway: true,
    }, { onSuccess: setResult });
  };
  const allowedUsersReview = dmPolicy === "open"
    ? "未限制"
    : dmPolicy === "pairing"
      ? "走配对确认"
    : compactList([
      ...(useScannedUserId ? [`扫码用户 ${last(scannedUserId)}`] : []),
      ...(manualAllowedCount > 0 ? [`手动 ${manualAllowedCount} 个`] : []),
    ]) || "缺少用户 ID";
  const homeChannelReview = shouldAutoWeixinHomeChannel ? `扫码用户 ${last(scannedUserId)}` : homeChannel.trim() || "保持原配置";
  const rows: Array<[string, string, string]> = [
    ["账号 ID", `WEIXIN_ACCOUNT_ID=${credential?.accountId?.redactedValue ?? accountId}`, credential ? "扫码返回" : "手动"],
    ["认证 Token", `WEIXIN_TOKEN=${credential?.token?.redactedValue ?? (token ? "••••" : "")}`, "敏感"],
    ["私聊策略", `WEIXIN_DM_POLICY=${dmPolicyValue}`, dmPolicy === "open" ? "试用开放" : dmPolicy === "pairing" ? "需要确认" : "只允许白名单"],
    ["允许用户", `WEIXIN_ALLOWED_USERS=${allowedUsersReview}`, dmPolicy === "pairing" ? "无需预填" : allowPolicyReady ? "可保存" : "缺少用户 ID"],
    ["允许所有用户", `WEIXIN_ALLOW_ALL_USERS=${dmPolicy === "open" ? "true" : "false"}`, "安全默认"],
    ["默认通知会话", `WEIXIN_HOME_CHANNEL=${homeChannelReview}`, shouldAutoWeixinHomeChannel ? "自动设置" : homeChannel.trim() ? "已填写" : "不改动"],
  ];
  const diagnosticBundle = useMemo(() => buildImDiagnosticBundle({
    platform: "weixin",
    currentProfile: stateQuery.data?.currentProfile,
    hermesHome: stateQuery.data?.hermesHome,
    envPath: stateQuery.data?.envPath,
    configured,
    statusData: statusQuery.data,
    platformInfo: messagingPlatformQuery.data,
    testResult: testPlatform.data,
    testError: testPlatform.error,
    applyResult: result,
    beginError: begin.error,
    pollError: poll.error,
    applyError: apply.error,
    stateError: stateQuery.error,
    qrStatus: status,
    qrMessage: pollResult?.message ?? flow?.message,
    credential,
  }), [
    apply.error,
    begin.error,
    configured,
    credential,
    flow?.message,
    messagingPlatformQuery.data,
    poll.error,
    pollResult?.message,
    result,
    stateQuery.data?.currentProfile,
    stateQuery.data?.envPath,
    stateQuery.data?.hermesHome,
    stateQuery.error,
    status,
    statusQuery.data,
    testPlatform.data,
    testPlatform.error,
  ]);
  const askHermesToDiagnose = async () => {
    setDiagnosticError(null);
    setDiagnosticPending(true);
    try {
      await createAndSendSession({
        text: buildImDiagnosticPrompt(diagnosticBundle),
        attachments: [],
      }, { updateAttachment: () => undefined });
    } catch (error) {
      setDiagnosticError(textFromError(error) ?? "无法打开 Hermes 排查会话");
    } finally {
      setDiagnosticPending(false);
    }
  };

  return (
    <SectionShell title="消息平台接入 · 微信" sub="03 消息接入 / 031 消息平台接入" rail={<Rail platform="weixin" />} railLabel="微信接入诊断边栏">
      <div className={s.wrap}>
        <main className={s.mainCol}>
          <Hero platform="weixin" stateSub={`当前档案：${stateQuery.data?.currentProfile ?? "default"}`} onPrimary={start} primaryBusy={busy} />
          <ActionFeedback busy={begin.isPending} error={begin.error} flow={flow} status={status} onJump={jumpToQr} />
          <MetaStrip platform="weixin" profile={stateQuery.data?.currentProfile ?? "default"} statusData={statusQuery.data} configured={configured} />
          <FlowSteps platform="weixin" status={status} saved={Boolean(result?.ok)} />
          <SectionTitle num="[ STEP 01 ]" title="先检查能不能接收消息" meta="桌面端会检查所需组件和网关" />
          <section className={s.section}><div className={s.verifyGrid}>
            <div className={s.verifyRow}><ShieldCheck size={16} /><div><b>网关状态</b><small>{statusQuery.data?.gateway_running ? "当前网关可重启。" : "网关还没启动，保存后会自动尝试启动。"}</small></div></div>
            <div className={s.verifyRow}><KeyRound size={16} /><div><b>微信绑定</b><small>{configured.WEIXIN_ACCOUNT_ID?.isSet ? `已保存 ${last(configured.WEIXIN_ACCOUNT_ID)}` : "尚未完成微信扫码绑定。"}</small></div></div>
          </div></section>
          <div ref={qrAnchorRef} className={s.anchorBlock}>
            <SectionTitle num="[ STEP 02 ]" title="用微信扫码确认" meta="默认 8 分钟有效，过期后会自动刷新几次" />
            <QrPanel
              data={pollResult?.qrScanData ?? flow?.qrScanData}
              url={pollResult?.qrUrl ?? flow?.qrUrl}
              status={status}
              message={pollResult?.message ?? flow?.message}
              onStart={start}
              startLabel="开始扫码"
              startBusy={begin.isPending}
            />
          </div>
          <div className={s.sectionActions}><button className={`${s.btn} ${s.primary}`} onClick={start} disabled={busy}><ScanLine size={14} />生成二维码</button><button className={s.btn} onClick={pollOnce} disabled={!flow || busy}><RotateCw size={14} />立即检查</button></div>
          <SectionTitle num="[ STEP 03 ]" title="确认扫码结果" meta="无需手填账号、口令或接口地址" />
          <section className={s.section}>
            {credential ? (
              <div className={s.identityNote}>
                <b>已拿到微信扫码信息</b>
                <span>账号 <code>{last(credential.accountId)}</code> 和口令会自动保存；如果扫码返回了用户 ID，桌面端会自动写入 <code>WEIXIN_ALLOWED_USERS</code> 和 <code>WEIXIN_HOME_CHANNEL</code>。</span>
              </div>
            ) : (
              <div className={s.identityNote}>
                <b>等待微信扫码</b>
                <span>推荐直接扫码完成绑定。只有恢复旧配置，或默认接入地址不可用时，才需要展开下面的高级设置手动填写。</span>
              </div>
            )}
            <div className={s.advancedPanel} data-open={showAdvanced ? "true" : undefined}>
              <button className={s.advancedHeader} type="button" onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced}>
                <span>
                  <b>高级设置 / 恢复旧配置</b>
                  <small>默认不用动；这里主要给已有账号、口令或自定义接入地址的用户使用。</small>
                </span>
                <em>{showAdvanced ? "收起" : "展开"}</em>
              </button>
              {showAdvanced ? (
                <div className={s.advancedBody}>
                  <Field label="微信接入账号" desc="扫码成功后自动带出；恢复旧配置时才需要手动填。" meta="WEIXIN_ACCOUNT_ID"><input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder={last(credential?.accountId)} /></Field>
                  <Field label="微信接入口令" desc="敏感信息，只保存在当前配置档案。" meta="WEIXIN_TOKEN"><input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={last(credential?.token)} /></Field>
                  <Field label="消息接口地址" desc="默认值即可，不知道就不要改。" meta="WEIXIN_BASE_URL"><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></Field>
                  <Field label="媒体接口地址" desc="用于图片、文件等媒体内容，默认即可。" meta="WEIXIN_CDN_BASE_URL"><input value={cdnBaseUrl} onChange={(e) => setCdnBaseUrl(e.target.value)} /></Field>
                </div>
              ) : null}
            </div>
          </section>
          <SectionTitle num="[ STEP 04 ]" title="设置谁可以使用" meta="默认只允许扫码用户，避免陌生用户直接使用" />
          <section className={s.section}>
            <div className={s.policyGrid}>
              <PolicyCard active={dmPolicy === "allowlist"} title="只允许扫码用户" desc={scannedUserId ? `默认加入本次扫码用户（${last(scannedUserId)}）。` : "扫码完成后会自动加入本次微信用户。"} onClick={() => setDmPolicy("allowlist")} />
              <PolicyCard active={dmPolicy === "pairing"} title="需要确认再放行" desc="没有拿到用户 ID 时也能先保存；陌生用户发 hi 会收到配对提示。" onClick={() => setDmPolicy("pairing")} />
              <PolicyCard active={dmPolicy === "open"} warning title="所有私聊都可用" desc="方便试用，但不建议长期开放。" onClick={() => setDmPolicy("open")} />
            </div>
            {dmPolicy === "allowlist" && (
              <>
                {scannedUserId ? (
                  <div className={s.identityNote}>
                    <b>已自动选择扫码用户</b>
                    <span>保存时会把完整用户 ID 写入允许列表，界面只展示隐藏值 <code>{last(scannedUserId)}</code>。</span>
                  </div>
                ) : null}
                <Field label="额外允许用户" desc="可选。多个微信用户 ID 用英文逗号分隔；不确定就留空。" meta="WEIXIN_ALLOWED_USERS"><input value={allowedUsers} onChange={(e) => setAllowedUsers(e.target.value)} placeholder="wxid_xxx,wxid_yyy" /></Field>
              </>
            )}
            <Field label="默认通知会话" desc={scannedUserId ? "留空会自动使用本次扫码用户；也可以手动指定 filehelper 或微信 user_id。" : "用于定时任务和通知；扫码成功后可自动填，也可以手动填。"} meta="WEIXIN_HOME_CHANNEL"><input value={homeChannel} onChange={(e) => setHomeChannel(e.target.value)} placeholder={scannedUserId ? "留空自动使用扫码用户" : "wxid_xxx / filehelper / user_id"} /></Field>
          </section>
          <SectionTitle num="[ REVIEW ]" title="保存前看一眼" meta="口令会自动隐藏" />
          <ReviewTable rows={rows} />
          <div className={s.sectionActions}><button className={`${s.btn} ${s.primary}`} onClick={save} disabled={busy || !(canApplyQr || canApplyManual || canApplySaved) || !allowPolicyReady}><Save size={14} />{canApplyQr || canApplyManual ? "保存并启动网关" : "重新启动网关"}</button></div>
          <ApplyResult result={result} />
          <SectionTitle num="[ STEP 05 ]" title="发一条消息试试" meta="私聊微信机器人，确认真的能回复" />
          <MessagingTestGuide
            result={result}
            platform={messagingPlatformQuery.data}
            platformLoading={messagingPlatformQuery.isLoading}
            testResult={testPlatform.data}
            testError={testPlatform.error}
            testPending={testPlatform.isPending}
            onTest={() => testPlatform.mutate()}
            platformLabel="微信"
            readyCopy="网关已经按当前档案重启。先点一次检测确认连接，再去微信里私聊机器人发送 hi。"
            notReadyCopy="先扫码保存并启动网关，再回来私聊机器人验证。"
          />
          <DiagnosticAssistant
            bundle={diagnosticBundle}
            onAskHermes={askHermesToDiagnose}
            asking={diagnosticPending}
            askError={diagnosticError}
          />
          {(begin.error || poll.error || apply.error || stateQuery.error) && <div className={s.errorBox}><XCircle size={16} />{textFromError(begin.error || poll.error || apply.error || stateQuery.error)}</div>}
        </main>
      </div>
    </SectionShell>
  );
}

export function ImOnboardingRoute() {
  const { pathname } = useLocation();
  const section = sectionFromPath(pathname);
  if (!section) return <Navigate to="/im/feishu" replace />;
  return section === "feishu" ? <FeishuRoute /> : <WeixinRoute />;
}
