import { useEffect, useRef, useState, type ReactNode } from "react";
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
  Send,
  ShieldCheck,
  Stethoscope,
  X,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type {
  ImCredentialSummary,
  ImOnboardingApplyResult,
  ImOnboardingBeginResult,
  ImOnboardingPollResult,
  ImPlatform,
  ImRedactedValue,
} from "@hermes/protocol";
import { useStatus } from "@/hooks/use-status";
import {
  useApplyImOnboarding,
  useBeginImOnboarding,
  useImOnboardingState,
  usePollImOnboarding,
} from "@/hooks/use-im-onboarding";
import { openExternalUrl } from "@/lib/external-links";
import { SectionShell } from "./section-shell";
import s from "./im-onboarding.module.css";

type ImSection = "feishu" | "weixin";
type FeishuMethod = "qr" | "manual";
type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
type FeishuGroupPolicy = "mention" | "disabled";

const FEISHU_DEVELOPER_URL = "https://open.feishu.cn/app";
export const FEISHU_REQUIRED_SCOPES = [
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message:send_as_bot",
] as const;
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
        <div className={s.heroKicker}><span>{isFeishu ? "№ 023A" : "№ 023B"}</span><span>IM ONBOARDING</span><em>配置 / 消息平台接入 / {isFeishu ? "飞书 · Lark" : "微信 · Weixin"}</em></div>
        <h1>将<em>{isFeishu ? "飞书消息平台" : "微信消息平台"}</em>接入<br />中文社区桌面版</h1>
        <p className={s.sub}>{isFeishu
          ? "跟着向导用手机扫码，保存到当前档案后，再按提示到飞书后台勾选权限并发布。全程不需要敲命令，新手也能一步步完成。"
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
    ? (configured.FEISHU_CONNECTION_MODE?.redactedValue === "webhook" ? "回调模式" : "长连接")
    : "自动轮询";
  const credentialSet = platform === "feishu"
    ? Boolean(configured.FEISHU_APP_ID?.isSet && configured.FEISHU_APP_SECRET?.isSet)
    : Boolean(configured.WEIXIN_ACCOUNT_ID?.isSet && configured.WEIXIN_TOKEN?.isSet);
  return (
    <div className={s.metaStrip}>
      <div><span>连接方式</span><b>{connectionLabel}</b></div>
      <div><span>档案</span><b>{profile || "default"}</b></div>
      <div><span>接收服务</span><b data-tone={statusData?.gateway_running ? "ok" : "warn"}>{statusData?.gateway_running ? "已运行" : "未运行"}</b></div>
      <div><span>凭据</span><b data-tone={credentialSet ? "ok" : "warn"}>{credentialSet ? "已保存" : "未保存"}</b></div>
      <div><span>平台连接</span><b data-tone={runtime?.state === "connected" ? "ok" : undefined}>{runtime?.state === "connected" ? "已连接" : "待连接"}</b></div>
    </div>
  );
}

function FlowSteps({ platform, status, saved }: { platform: ImPlatform; status?: string; saved: boolean }) {
  const scanned = status === "scanned" || status === "confirmed";
  const confirmed = status === "confirmed";
  const labels = platform === "feishu"
    ? [["选择方式", "推荐扫码"], ["绑定应用", "用手机确认"], ["保存设置", "写入当前档案"], ["打开权限", "按提示勾选发布"], ["试发消息", "私聊和群聊验证"]]
    : [["环境检查", "确认能启动"], ["扫码绑定", "用微信确认"], ["访问范围", "设置可用用户"], ["保存验证", "重启后自动检查"]];
  const states = platform === "feishu"
    ? [true, scanned || confirmed, saved, false, false]
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

function FeishuBackendChecklist() {
  const requiredScopes = FEISHU_REQUIRED_SCOPES.join("\n");
  const recommendedScopes = FEISHU_RECOMMENDED_SCOPES.join("\n");
  const importJson = JSON.stringify({
    scopes: {
      tenant: [...FEISHU_REQUIRED_SCOPES, ...FEISHU_RECOMMENDED_SCOPES],
    },
  }, null, 2);

  return (
    <section className={`${s.section} ${s.backendChecklist}`}>
      <div className={s.checkIntro}>
        <div>
          <div className={s.miniEyebrow}>FEISHU CONSOLE</div>
          <h3>飞书后台还要点几下</h3>
          <p>扫码只是把应用信息带回来。想让桌面端真的收到消息，需要在飞书开放平台打开机器人能力、消息事件和发送权限，最后发布一次版本。</p>
        </div>
        <button className={`${s.btn} ${s.externalBtn}`} type="button" onClick={() => openExternal(FEISHU_DEVELOPER_URL)}>
          <ExternalLink size={14} />打开飞书开发者后台
        </button>
      </div>

      <div className={s.consoleSteps}>
        <div className={s.consoleStep}>
          <span>1</span>
          <b>先点上面的保存</b>
          <p>保存后桌面端会启动接收服务，飞书后台才能把消息投递过来。</p>
        </div>
        <div className={s.consoleStep}>
          <span>2</span>
          <b>订阅接收消息</b>
          <p>在「事件与回调」里选择长连接接收事件，然后添加「接收消息 v2.0」。</p>
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
          <div className={s.scopeHead}><b>必须权限</b><button type="button" onClick={() => copyText(requiredScopes)}>复制</button></div>
          {FEISHU_REQUIRED_SCOPES.map((scope) => <code key={scope}>{scope}</code>)}
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

function FeishuTestGuide({ result }: { result: ImOnboardingApplyResult | null }) {
  return (
    <section className={`${s.section} ${s.testGuide}`} data-ready={result?.ok ? "true" : undefined}>
      <div>
        <div className={s.miniEyebrow}>LIVE TEST</div>
        <h3>最后发消息试一下</h3>
        <p>{result?.ok
          ? "接收服务已经启动。现在去飞书里试两条：私聊机器人发 hi；群里 @机器人 发 hi。"
          : "先保存、完成飞书后台设置并发布，再回来发消息验证。"}</p>
      </div>
      <div className={s.testCards}>
        <div><MessageSquareText size={15} /><b>私聊测试</b><span>给机器人发送 <code>hi</code>，应收到回复或配对提示。</span></div>
        <div><Send size={15} /><b>群聊测试</b><span>把机器人拉入群并发送 <code>@机器人 hi</code>，默认只响应 @ 消息。</span></div>
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
            title: "最小闭环",
            items: ["机器人能力已打开", "消息事件已订阅", `事件里包含 ${FEISHU_RECEIVE_EVENT}`, "应用已创建版本并发布"],
          },
          {
            title: "必须权限",
            items: Array.from(FEISHU_REQUIRED_SCOPES),
            chips: ["单聊可收", "群聊 @ 可收", "机器人可发"],
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
        summary: "新手不用准备公网地址或内网穿透，桌面端会自己和飞书保持连接。",
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
            items: ["私聊没反应：确认已开通私聊消息权限并发布", "群里没反应：确认已开通群聊 @ 消息权限，并且消息里 @ 了机器人", "能收不能发：确认已开通机器人发送消息权限", "事件日志为空：确认已订阅接收消息 v2.0 并发布版本"],
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
      label: "iLink",
      tone: "accent",
      eyebrow: "ILINK BOT",
      title: "这是微信消息平台接入",
      summary: "这里接的是微信消息平台，不是企业微信或公众号后台。",
      sections: [
        {
          title: "接入边界",
          items: ["扫码获取微信接入账号和口令", "桌面端会定时拉取新消息", "图片和文件走单独的媒体地址"],
        },
        {
          title: "安全默认",
          body: "账号和口令只写入当前配置档案，页面摘要会自动打码。",
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
      summary: "这里只显示依赖、接收状态和配置缺口，不显示 token 原文。",
      sections: [
        {
          title: "快速排查",
          items: ["提示依赖缺失：按提示安装 aiohttp / cryptography", "提示未绑定：重新扫码或手动恢复账号", "提示已被占用：先停止另一个接收服务"],
        },
        {
          title: "日志关键词",
          chips: ["微信连接状态", "消息拉取", "接收服务占用"],
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
        <b>配置已写入当前档案：{result.currentProfile}</b>
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
  const [method, setMethod] = useState<FeishuMethod>("qr");
  const [domain, setDomain] = useState("feishu");
  const [connectionMode, setConnectionMode] = useState("websocket");
  const [dmPolicy, setDmPolicy] = useState<DmPolicy>("pairing");
  const [groupPolicy, setGroupPolicy] = useState<FeishuGroupPolicy>("mention");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [homeChannel, setHomeChannel] = useState("");
  const [webhookHost, setWebhookHost] = useState("127.0.0.1");
  const [webhookPort, setWebhookPort] = useState("8765");
  const [webhookPath, setWebhookPath] = useState("/feishu/webhook");
  const [encryptKey, setEncryptKey] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [flow, setFlow] = useState<ImOnboardingBeginResult | null>(null);
  const [pollResult, setPollResult] = useState<ImOnboardingPollResult | null>(null);
  const [result, setResult] = useState<ImOnboardingApplyResult | null>(null);
  const qrAnchorRef = useRef<HTMLDivElement>(null);

  const configured = stateQuery.data?.configured ?? {};
  const status = pollResult?.status ?? flow?.status;
  const credential = pollResult?.credentialSummary;
  const canApplyQr = method === "qr" && credential && pollResult?.status === "confirmed";
  const canApplyManual = method === "manual" && appId.trim() && appSecret.trim();
  const busy = begin.isPending || poll.isPending || apply.isPending;
  const jumpToQr = () => qrAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const start = () => {
    begin.reset();
    poll.reset();
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

  const settings = () => {
    const allowAll = dmPolicy === "open" ? "true" : "false";
    return {
      FEISHU_DOMAIN: domain,
      FEISHU_CONNECTION_MODE: connectionMode,
      FEISHU_ALLOW_ALL_USERS: allowAll,
      FEISHU_ALLOWED_USERS: dmPolicy === "allowlist" ? allowedUsers.replaceAll(" ", "") : "",
      FEISHU_GROUP_POLICY: groupPolicy === "disabled" ? "disabled" : "open",
      FEISHU_REQUIRE_MENTION: groupPolicy === "mention" ? "true" : "false",
      FEISHU_HOME_CHANNEL: homeChannel.trim(),
      ...(connectionMode === "webhook" ? {
        FEISHU_WEBHOOK_HOST: webhookHost.trim(),
        FEISHU_WEBHOOK_PORT: webhookPort.trim(),
        FEISHU_WEBHOOK_PATH: webhookPath.trim(),
        FEISHU_ENCRYPT_KEY: encryptKey.trim(),
        FEISHU_VERIFICATION_TOKEN: verificationToken.trim(),
      } : {}),
    };
  };
  const save = () => {
    apply.mutate({
      platform: "feishu",
      flowId: method === "qr" ? flow?.flowId : undefined,
      manualCredentials: method === "manual" ? { appId, appSecret } : undefined,
      settings: settings(),
      restartGateway: true,
    }, { onSuccess: setResult });
  };
  const rows: Array<[string, string, string]> = [
    ["连接模式", `FEISHU_CONNECTION_MODE=${connectionMode}`, connectionMode === "websocket" ? "推荐" : "高级"],
    ["区域", `FEISHU_DOMAIN=${domain}`, "已选择"],
    ["私聊策略", `FEISHU_ALLOW_ALL_USERS=${dmPolicy === "open" ? "true" : "false"}`, dmPolicy === "pairing" ? "推荐：先确认" : dmPolicy],
    ["群聊策略", `FEISHU_GROUP_POLICY=${groupPolicy === "disabled" ? "disabled" : "open"}`, groupPolicy === "mention" ? "仅 @ 响应" : "关闭"],
    ["首页频道", `FEISHU_HOME_CHANNEL=${homeChannel || ""}`, homeChannel ? "已填写" : "稍后设置"],
  ];

  return (
    <SectionShell title="消息平台接入 · 飞书" sub="02 配置 / 023 消息平台接入" rail={<Rail platform="feishu" />} railLabel="飞书接入诊断边栏">
      <div className={s.wrap}>
        <main className={s.mainCol}>
          <Hero platform="feishu" stateSub={`当前档案：${stateQuery.data?.currentProfile ?? "default"}`} onPrimary={method === "qr" ? start : save} primaryBusy={busy} />
          <ActionFeedback busy={begin.isPending} error={begin.error} flow={flow} status={status} onJump={jumpToQr} />
          <MetaStrip platform="feishu" profile={stateQuery.data?.currentProfile ?? "default"} statusData={statusQuery.data} configured={configured} />
          <FlowSteps platform="feishu" status={status} saved={Boolean(result?.ok)} />
          <SectionTitle num="[ STEP 01 ]" title="先选择怎么接入" meta="新手推荐扫码；已有飞书应用再手动填写" />
          <section className={s.section}><div className={s.choiceGrid}>
            <ChoiceCard active={method === "qr"} icon="scan" badge="推荐" title="手机扫码接入" desc="用飞书手机端扫一下，桌面端会自动拿到应用信息。扫码后还需要按提示去飞书后台确认权限。" foot="推荐新手使用" onClick={() => setMethod("qr")} />
            <ChoiceCard active={method === "manual"} icon="key" badge="高级" title="我已有飞书应用" desc="如果公司已经建好自建应用，可以在这里填写应用信息。" foot="适合熟悉飞书后台的用户" onClick={() => setMethod("manual")} />
          </div></section>

          {method === "qr" ? <>
            <div ref={qrAnchorRef} className={s.anchorBlock}>
              <SectionTitle num="[ STEP 02A ]" title="用飞书扫码确认" meta={flow ? `每 ${flow.intervalSeconds} 秒自动检查一次；成功后继续下一步` : "二维码只在当前页面临时使用"} />
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
          </> : <>
            <SectionTitle num="[ STEP 02B ]" title="填写已有飞书应用" meta="密码类信息不会在诊断里明文显示" />
            <section className={s.section}>
              <Field label="区域" desc="选择你使用的是飞书中国版还是 Lark 国际版。" meta="FEISHU_DOMAIN"><select value={domain} onChange={(e) => setDomain(e.target.value)}><option value="feishu">飞书中国 · feishu</option><option value="lark">Lark 国际 · lark</option></select></Field>
              <Field label="连接模式" desc="新手保持默认即可，不需要准备公网地址。" meta="FEISHU_CONNECTION_MODE"><select value={connectionMode} onChange={(e) => setConnectionMode(e.target.value)}><option value="websocket">长连接（推荐）</option><option value="webhook">回调模式（高级）</option></select></Field>
              <Field label="App ID" desc="在飞书开放平台应用详情里复制。" meta="FEISHU_APP_ID"><input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="cli_xxx" /></Field>
              <Field label="App Secret" desc="应用密钥，只保存在当前配置档案里。" meta="FEISHU_APP_SECRET"><input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="••••••••" /></Field>
              {connectionMode === "webhook" && <>
                <Field label="回调地址" desc="只有选择回调模式时才需要填写。" meta="FEISHU_WEBHOOK_HOST"><input value={webhookHost} onChange={(e) => setWebhookHost(e.target.value)} /></Field>
                <Field label="回调端口" desc="本机接收飞书回调的端口。" meta="FEISHU_WEBHOOK_PORT"><input value={webhookPort} onChange={(e) => setWebhookPort(e.target.value)} /></Field>
                <Field label="回调路径" desc="飞书后台里填写的回调路径。" meta="FEISHU_WEBHOOK_PATH"><input value={webhookPath} onChange={(e) => setWebhookPath(e.target.value)} /></Field>
                <Field label="回调加密" desc="如果后台要求加密，填这里；不确定可以先留空。" meta="FEISHU_ENCRYPT_KEY"><input type="password" value={encryptKey} onChange={(e) => setEncryptKey(e.target.value)} /></Field>
                <Field label="校验口令" desc="飞书后台的校验口令，不确定可以先留空。" meta="FEISHU_VERIFICATION_TOKEN"><input type="password" value={verificationToken} onChange={(e) => setVerificationToken(e.target.value)} /></Field>
              </>}
              <div className={s.sectionActions}><button className={`${s.btn} ${s.externalBtn}`} onClick={() => openExternal(FEISHU_DEVELOPER_URL)}><ExternalLink size={14} />打开飞书开发者后台</button></div>
            </section>
          </>}

          <SectionTitle num="[ STEP 03 ]" title="保存设置并启动接收服务" meta="只会更新当前配置档案；飞书后台还需要继续按提示确认" />
          <section className={s.section}>
            <div className={s.policyGrid}>
              <PolicyCard active={dmPolicy === "pairing"} title="需要确认再放行" desc="陌生用户先发起申请，管理员同意后可用。" onClick={() => setDmPolicy("pairing")} />
              <PolicyCard active={dmPolicy === "allowlist"} title="只允许指定用户" desc="只让列表里的用户 ID 使用。" onClick={() => setDmPolicy("allowlist")} />
              <PolicyCard active={dmPolicy === "open"} warning title="所有私聊都可用" desc="方便试用，但不建议长期开放。" onClick={() => setDmPolicy("open")} />
            </div>
            {dmPolicy === "allowlist" && <Field label="允许用户" desc="多个用户 ID 用英文逗号分隔；不知道用户 ID 可先跳过。" meta="FEISHU_ALLOWED_USERS"><input value={allowedUsers} onChange={(e) => setAllowedUsers(e.target.value)} /></Field>}
            <Field label="群聊策略" desc="为了避免刷屏，默认只有 @Hermes 时才回复。" meta="FEISHU_GROUP_POLICY"><select value={groupPolicy} onChange={(e) => setGroupPolicy(e.target.value as FeishuGroupPolicy)}><option value="mention">启用群聊，仅 @Hermes 时响应</option><option value="disabled">关闭群聊</option></select></Field>
            <Field label="默认通知会话" desc="用于定时任务和通知；不知道可以先留空。" meta="FEISHU_HOME_CHANNEL"><input value={homeChannel} onChange={(e) => setHomeChannel(e.target.value)} placeholder="oc_xxx 或留空" /></Field>
          </section>

          <SectionTitle num="[ REVIEW ]" title="保存前看一眼" meta="密钥会自动打码；保存后继续去飞书后台确认" />
          {credential && <div className={s.summaryLine}>扫码结果：应用 ID {last(credential.appId)} · 应用密钥 {last(credential.appSecret)} · 机器人 {credential.botName ?? "未探测"}</div>}
          <ReviewTable rows={rows} />
          <div className={s.sectionActions}><button className={`${s.btn} ${s.primary}`} onClick={save} disabled={busy || !(canApplyQr || canApplyManual)}><Save size={14} />保存并启动接收服务</button></div>
          <ApplyResult result={result} />
          <SectionTitle num="[ STEP 04 ]" title="打开飞书后台完成权限" meta="按清单勾选权限、订阅消息并发布版本" />
          <FeishuBackendChecklist />
          <SectionTitle num="[ STEP 05 ]" title="发一条消息试试" meta="私聊和群聊各试一次，确认真的能回复" />
          <FeishuTestGuide result={result} />
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
  const [dmPolicy, setDmPolicy] = useState<DmPolicy>("pairing");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [homeChannel, setHomeChannel] = useState("");
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://ilinkai.weixin.qq.com");
  const [cdnBaseUrl, setCdnBaseUrl] = useState("https://novac2c.cdn.weixin.qq.com/c2c");
  const [flow, setFlow] = useState<ImOnboardingBeginResult | null>(null);
  const [pollResult, setPollResult] = useState<ImOnboardingPollResult | null>(null);
  const [result, setResult] = useState<ImOnboardingApplyResult | null>(null);
  const qrAnchorRef = useRef<HTMLDivElement>(null);
  const configured = stateQuery.data?.configured ?? {};
  const status = pollResult?.status ?? flow?.status;
  const credential = pollResult?.credentialSummary;
  const busy = begin.isPending || poll.isPending || apply.isPending;
  const canApplyQr = credential && pollResult?.status === "confirmed";
  const canApplyManual = accountId.trim() && token.trim();
  const jumpToQr = () => qrAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const start = () => {
    begin.reset();
    poll.reset();
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

  const settings = () => ({
    WEIXIN_BASE_URL: baseUrl.trim().replace(/\/$/, ""),
    WEIXIN_CDN_BASE_URL: cdnBaseUrl.trim().replace(/\/$/, ""),
    WEIXIN_DM_POLICY: dmPolicy,
    WEIXIN_ALLOW_ALL_USERS: dmPolicy === "open" ? "true" : "false",
    WEIXIN_ALLOWED_USERS: dmPolicy === "allowlist" ? allowedUsers.replaceAll(" ", "") : "",
    WEIXIN_GROUP_POLICY: "disabled",
    WEIXIN_GROUP_ALLOWED_USERS: "",
    WEIXIN_HOME_CHANNEL: homeChannel.trim(),
  });
  const save = () => apply.mutate({
    platform: "weixin",
    flowId: flow?.flowId,
    manualCredentials: canApplyQr ? undefined : { accountId, token, baseUrl },
    settings: settings(),
    restartGateway: true,
  }, { onSuccess: setResult });
  const rows: Array<[string, string, string]> = [
    ["账号 ID", `WEIXIN_ACCOUNT_ID=${credential?.accountId?.redactedValue ?? accountId}`, credential ? "扫码返回" : "手动"],
    ["认证 Token", `WEIXIN_TOKEN=${credential?.token?.redactedValue ?? (token ? "••••" : "")}`, "敏感"],
    ["私聊策略", `WEIXIN_DM_POLICY=${dmPolicy}`, dmPolicy === "pairing" ? "推荐：先确认" : dmPolicy],
    ["允许所有用户", `WEIXIN_ALLOW_ALL_USERS=${dmPolicy === "open" ? "true" : "false"}`, "安全默认"],
  ];

  return (
    <SectionShell title="消息平台接入 · 微信" sub="02 配置 / 023 消息平台接入" rail={<Rail platform="weixin" />} railLabel="微信接入诊断边栏">
      <div className={s.wrap}>
        <main className={s.mainCol}>
          <Hero platform="weixin" stateSub={`当前档案：${stateQuery.data?.currentProfile ?? "default"}`} onPrimary={start} primaryBusy={busy} />
          <ActionFeedback busy={begin.isPending} error={begin.error} flow={flow} status={status} onJump={jumpToQr} />
          <MetaStrip platform="weixin" profile={stateQuery.data?.currentProfile ?? "default"} statusData={statusQuery.data} configured={configured} />
          <FlowSteps platform="weixin" status={status} saved={Boolean(result?.ok)} />
          <SectionTitle num="[ STEP 01 ]" title="先检查能不能接收消息" meta="桌面端会检查所需组件和接收服务" />
          <section className={s.section}><div className={s.verifyGrid}>
            <div className={s.verifyRow}><ShieldCheck size={16} /><div><b>接收服务状态</b><small>{statusQuery.data?.gateway_running ? "当前接收服务可重启。" : "接收服务还没启动，保存后会自动尝试启动。"}</small></div></div>
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
          <SectionTitle num="[ STEP 03 ]" title="账号信息和连接地址" meta="新手不用手填，扫码成功后会自动保存" />
          <section className={s.section}>
            <Field label="微信接入账号" desc="扫码成功后自动带出；恢复旧配置时才需要手动填。" meta="WEIXIN_ACCOUNT_ID"><input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder={last(credential?.accountId)} /></Field>
            <Field label="微信接入口令" desc="敏感信息，只保存在当前配置档案。" meta="WEIXIN_TOKEN"><input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={last(credential?.token)} /></Field>
            <Field label="消息接口地址" desc="默认值即可，不知道就不要改。" meta="WEIXIN_BASE_URL"><input value={credential?.baseUrl ?? baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></Field>
            <Field label="媒体接口地址" desc="用于图片、文件等媒体内容，默认即可。" meta="WEIXIN_CDN_BASE_URL"><input value={cdnBaseUrl} onChange={(e) => setCdnBaseUrl(e.target.value)} /></Field>
          </section>
          <SectionTitle num="[ STEP 04 ]" title="设置谁可以使用" meta="默认需要先确认，避免陌生用户直接使用" />
          <section className={s.section}>
            <div className={s.policyGrid}>
              <PolicyCard active={dmPolicy === "pairing"} title="需要确认再放行" desc="陌生用户私聊时先生成确认码。" onClick={() => setDmPolicy("pairing")} />
              <PolicyCard active={dmPolicy === "allowlist"} title="只允许指定用户" desc="只有列表里的微信用户 ID 可用。" onClick={() => setDmPolicy("allowlist")} />
              <PolicyCard active={dmPolicy === "open"} warning title="所有私聊都可用" desc="方便试用，但不建议长期开放。" onClick={() => setDmPolicy("open")} />
            </div>
            {dmPolicy === "allowlist" && <Field label="允许用户" desc="多个用户 ID 用英文逗号分隔；不确定可先跳过。" meta="WEIXIN_ALLOWED_USERS"><input value={allowedUsers} onChange={(e) => setAllowedUsers(e.target.value)} /></Field>}
            <Field label="默认通知会话" desc="用于定时任务和通知；可以先留空。" meta="WEIXIN_HOME_CHANNEL"><input value={homeChannel} onChange={(e) => setHomeChannel(e.target.value)} placeholder="wxid_xxx / filehelper / user_id" /></Field>
          </section>
          <SectionTitle num="[ REVIEW ]" title="保存前看一眼" meta="口令会自动打码" />
          <ReviewTable rows={rows} />
          <div className={s.sectionActions}><button className={`${s.btn} ${s.primary}`} onClick={save} disabled={busy || !(canApplyQr || canApplyManual)}><Save size={14} />保存并启动接收服务</button></div>
          <ApplyResult result={result} />
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
