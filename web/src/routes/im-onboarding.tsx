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
  UsersRound,
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
import { SectionShell } from "./section-shell";
import s from "./im-onboarding.module.css";

type ImSection = "feishu" | "weixin";
type FeishuMethod = "qr" | "manual";
type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
type FeishuGroupPolicy = "mention" | "disabled";
type WeixinGroupPolicy = "disabled" | "open" | "allowlist";

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

  if (window.hermesDesktop?.openWorkspacePath) {
    void window.hermesDesktop.openWorkspacePath({ path: trimmed }).catch(() => {
      window.open(trimmed, "_blank", "noopener,noreferrer");
    });
    return;
  }

  window.open(trimmed, "_blank", "noopener,noreferrer");
}

function QrPanel({ data, url, status, message }: {
  data?: string | null;
  url?: string | null;
  status?: string;
  message?: string | null;
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
        {src ? <img src={src} alt="扫码接入二维码" /> : <div className={s.qrPlaceholder}>QR</div>}
      </div>
      <div className={s.qrCopy}>
        <div className={s.miniEyebrow}>QR ONBOARDING</div>
        <h3>使用手机扫码确认</h3>
        <p>{message || "生成二维码后，使用对应移动端扫码并在手机端确认。"}</p>
        <div className={s.traceRow}><span>状态</span><b>{statusText(status)}</b><em>{data ? "二维码数据只保存在当前页面" : "尚未生成二维码"}</em></div>
        {url && <code className={s.urlPreview}>{url}</code>}
        <div className={s.buttonRow}>
          <button className={s.btn} type="button" onClick={copy} disabled={!data}><ClipboardList size={14} />复制二维码数据</button>
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
        <h1>把<em>{isFeishu ? "飞书" : "微信"}</em>接到<br />Hermes。</h1>
        <p className={s.sub}>{isFeishu
          ? "将命令行里的 hermes gateway setup 拆成桌面端向导：获取应用凭据、写入当前 profile、启动长连接，再完成飞书后台权限、事件订阅、发版与真实消息验证。"
          : "微信接入不是企业微信或公众号回调。这里绑定 Tencent iLink bot 身份，并用 getupdates 长轮询接收消息。"}</p>
      </div>
      <div className={s.heroActions}>
        <span className={s.heroState}>{stateSub}</span>
        <button className={`${s.btn} ${s.primary}`} type="button" onClick={onPrimary} disabled={primaryBusy}>
          {isFeishu ? <ScanLine size={14} /> : <MessageSquareText size={14} />}
          {primaryBusy ? "处理中…" : isFeishu ? "获取凭据" : "开始扫码"}
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
        <b>{message ? "开始接入失败" : busy ? "正在生成扫码接入二维码" : "二维码已生成"}</b>
        <span>{message || (busy ? "正在调用桌面端接入命令，请稍候。" : `状态：${statusText(status ?? flow?.status)}。请到扫码区域继续操作。`)}</span>
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
  const credentialSet = platform === "feishu"
    ? Boolean(configured.FEISHU_APP_ID?.isSet && configured.FEISHU_APP_SECRET?.isSet)
    : Boolean(configured.WEIXIN_ACCOUNT_ID?.isSet && configured.WEIXIN_TOKEN?.isSet);
  return (
    <div className={s.metaStrip}>
      <div><span>传输</span><b>{platform === "feishu" ? (configured.FEISHU_CONNECTION_MODE?.redactedValue ?? "WebSocket") : "Long-poll"}</b></div>
      <div><span>档案</span><b>{profile || "default"}</b></div>
      <div><span>Gateway</span><b data-tone={statusData?.gateway_running ? "ok" : "warn"}>{statusData?.gateway_running ? "running" : "stopped"}</b></div>
      <div><span>凭据</span><b data-tone={credentialSet ? "ok" : "warn"}>{credentialSet ? "已保存" : "未保存"}</b></div>
      <div><span>平台</span><b data-tone={runtime?.state === "connected" ? "ok" : undefined}>{runtime?.state || "pending"}</b></div>
    </div>
  );
}

function FlowSteps({ platform, status, saved }: { platform: ImPlatform; status?: string; saved: boolean }) {
  const scanned = status === "scanned" || status === "confirmed";
  const confirmed = status === "confirmed";
  const labels = platform === "feishu"
    ? [["选择方式", "扫码或手动"], ["获取凭据", "扫码或手动填写"], ["保存启动", "写入 profile 并重启"], ["后台配置", "权限、事件与发布"], ["测试消息", "私聊和群聊 @ 验证"]]
    : [["环境检查", "依赖与 Gateway"], ["扫码绑定", "微信确认 iLink bot"], ["访问策略", "私聊、群聊与 home"], ["保存验证", "重启并检查 long-poll"]];
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
          <h3>扫码成功后，还要完成飞书后台配置</h3>
          <p>App ID / Secret 只是凭据。要让 Hermes 真正收到私聊、群聊 @ 并发出回复，需要在飞书开放平台确认机器人能力、长连接事件、权限和版本发布。</p>
        </div>
        <button className={`${s.btn} ${s.externalBtn}`} type="button" onClick={() => openExternal(FEISHU_DEVELOPER_URL)}>
          <ExternalLink size={14} />打开飞书开发者后台
        </button>
      </div>

      <div className={s.consoleSteps}>
        <div className={s.consoleStep}>
          <span>1</span>
          <b>先保存并启动 Gateway</b>
          <p>长连接订阅保存时可能要求应用已经建立连接，所以先把凭据写入当前 profile 并重启 Gateway。</p>
        </div>
        <div className={s.consoleStep}>
          <span>2</span>
          <b>事件订阅选择长连接</b>
          <p>在「事件与回调」里选择使用长连接接收事件，然后添加应用身份事件「接收消息 v2.0」。</p>
          <code>{FEISHU_RECEIVE_EVENT}</code>
        </div>
        <div className={s.consoleStep}>
          <span>3</span>
          <b>开通并发布权限</b>
          <p>权限开通后仍需创建版本并发布，未发布时飞书客户端里通常表现为机器人不回复。</p>
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
        <h3>最后用真实消息验证闭环</h3>
        <p>{result?.ok
          ? "Gateway 已尝试重启。现在请在飞书里用两条消息验证：私聊机器人发送 hi；在群聊里 @机器人 hi。"
          : "保存并重启 Gateway、完成飞书后台权限/事件/发布之后，再回来做真实消息验证。"}</p>
      </div>
      <div className={s.testCards}>
        <div><MessageSquareText size={15} /><b>私聊测试</b><span>给机器人发送 <code>hi</code>，应收到 Hermes 回复或配对提示。</span></div>
        <div><Send size={15} /><b>群聊 @ 测试</b><span>把机器人拉入群并发送 <code>@机器人 hi</code>，默认只响应 @ 消息。</span></div>
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
        summary: "扫码拿到凭据不等于能聊天；需要保存启动 Gateway 后，再确认飞书后台权限、事件订阅和发版状态。",
        sections: [
          {
            title: "最小闭环",
            items: ["机器人能力已启用", `长连接订阅方式已保存`, `事件订阅包含 ${FEISHU_RECEIVE_EVENT}`, "应用已创建版本并发布"],
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
        title: "为什么默认 WebSocket",
        summary: "桌面端运行在用户本机，WebSocket 能避开公网回调地址、域名和内网穿透要求。",
        sections: [
          {
            title: "产品默认",
            body: "长连接由官方 SDK 与开放平台建立，但飞书后台仍要添加接收消息事件并发布应用，事件才会真正投递到本地 Gateway。",
            chips: ["无需公网 IP", "适合桌面端", "链路更稳定"],
          },
          {
            title: "何时用 Webhook",
            items: ["已有企业统一回调网关", "需要集中审计所有开放平台事件", "明确有可访问公网域名"],
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
        summary: "这里仅展示可复现故障线索，不输出 app secret、token 或扫码凭据。",
        sections: [
          {
            title: "快速排查",
            items: ["私聊无响应：确认已开通 im:message.p2p_msg:readonly 并发布", "群聊无响应：确认已开通 im:message.group_at_msg:readonly 且消息里 @ 机器人", "能收不能发：确认已开通 im:message:send_as_bot", "事件日志为空：确认已订阅接收消息 v2.0 并创建版本发布"],
          },
          {
            title: "日志关键词",
            chips: ["gateway_platforms.feishu", "event subscription", "bot disabled"],
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
      title: "这是个人微信 iLink 接入",
      summary: "该页面不是企业微信、公众号或普通微信群稳定回调配置，只绑定 iLink bot 身份。",
      sections: [
        {
          title: "接入边界",
          items: ["扫码得到 iLink bot account_id 与 token", "消息通过 getupdates 长轮询进入 Gateway", "媒体走独立 CDN base url"],
        },
        {
          title: "安全默认",
          body: "account_id、token 和 base_url 在摘要中脱敏展示，保存时只写入当前 profile。",
          chips: ["非企微", "非公众号", "非微信群回调"],
        },
      ],
    },
    {
      id: "why",
      icon: UsersRound,
      label: "群聊",
      tone: "warn",
      eyebrow: "GROUP LIMIT",
      title: "微信群聊默认关闭",
      summary: "iLink bot 身份通常不能像普通联系人一样加入微信群，也不保证投递普通微信群事件。",
      sections: [
        {
          title: "默认策略",
          body: "先保证私聊扫码、配对审批和 Gateway 长轮询闭环，群聊能力只在真实投递可验证时开启。",
          chips: ["默认 disabled", "私聊优先", "可白名单试验"],
        },
        {
          title: "开启前确认",
          items: ["确认 iLink 实际投递 group id", "限制允许群聊列表", "避免把个人号群消息误当稳定 API"],
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
      summary: "诊断只展示依赖、轮询状态和配置缺口，不展示 token 原文。",
      sections: [
        {
          title: "快速排查",
          items: ["missing dependency：修复 aiohttp / cryptography", "WEIXIN_TOKEN missing：重新扫码或手动恢复", "token already locked：停止另一 Gateway"],
        },
        {
          title: "日志关键词",
          chips: ["gateway_platforms.weixin", "getupdates", "poller locked"],
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
  return (
    <div className={s.resultBox} data-ok={result.restart.ok ? "true" : undefined}>
      <CheckCircle2 size={16} />
      <div>
        <b>配置已写入当前 profile：{result.currentProfile}</b>
        <span>env: <code>{result.envPath}</code>{result.backupPath ? <> · backup: <code>{result.backupPath}</code></> : null}</span>
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
    ["私聊策略", `FEISHU_ALLOW_ALL_USERS=${dmPolicy === "open" ? "true" : "false"}`, dmPolicy],
    ["群聊策略", `FEISHU_GROUP_POLICY=${groupPolicy === "disabled" ? "disabled" : "open"}`, groupPolicy === "mention" ? "仅 @ 响应" : "关闭"],
    ["首页频道", `FEISHU_HOME_CHANNEL=${homeChannel || ""}`, homeChannel ? "已填写" : "稍后设置"],
  ];

  return (
    <SectionShell title="消息平台接入 · 飞书" sub="02 配置 / 023 消息平台接入" rail={<Rail platform="feishu" />} railLabel="飞书接入诊断边栏">
      <div className={s.wrap}>
        <main className={s.mainCol}>
          <Hero platform="feishu" stateSub={`当前 profile：${stateQuery.data?.currentProfile ?? "default"}`} onPrimary={method === "qr" ? start : save} primaryBusy={busy} />
          <ActionFeedback busy={begin.isPending} error={begin.error} flow={flow} status={status} onJump={jumpToQr} />
          <MetaStrip platform="feishu" profile={stateQuery.data?.currentProfile ?? "default"} statusData={statusQuery.data} configured={configured} />
          <FlowSteps platform="feishu" status={status} saved={Boolean(result?.ok)} />
          <SectionTitle num="[ STEP 01 ]" title="选择接入方式" meta="普通用户走扫码，企业已有应用走手动凭据" />
          <section className={s.section}><div className={s.choiceGrid}>
            <ChoiceCard active={method === "qr"} icon="scan" badge="推荐" title="扫码获取应用凭据" desc="用飞书手机端扫码授权，自动获取 App ID、App Secret 与机器人信息；后续仍需确认后台权限、事件与发布。" foot="无需公网回调地址" onClick={() => setMethod("qr")} />
            <ChoiceCard active={method === "manual"} icon="key" badge="高级" title="手动输入已有应用" desc="适合企业已有自建应用，需启用机器人能力并订阅消息事件。" foot="可切换 Webhook 模式" onClick={() => setMethod("manual")} />
          </div></section>

          {method === "qr" ? <>
            <div ref={qrAnchorRef} className={s.anchorBlock}>
              <SectionTitle num="[ STEP 02A ]" title="扫码授权并获取凭据" meta={flow ? `轮询间隔 ${flow.intervalSeconds}s；凭据获取后还要配置后台` : "device_code 只保存在桌面端内存"} />
              <QrPanel data={pollResult?.qrScanData ?? flow?.qrScanData} url={pollResult?.qrUrl ?? flow?.qrUrl} status={status} message={pollResult?.message ?? flow?.message} />
            </div>
            <div className={s.sectionActions}><button className={`${s.btn} ${s.primary}`} onClick={start} disabled={busy}><ScanLine size={14} />生成二维码</button><button className={s.btn} onClick={pollOnce} disabled={!flow || busy}><RefreshCw size={14} />立即检查</button></div>
          </> : <>
            <SectionTitle num="[ STEP 02B ]" title="手动输入已有飞书应用" meta="App Secret 不会进入诊断输出" />
            <section className={s.section}>
              <Field label="区域" desc="选择飞书中国或 Lark 国际。" meta="FEISHU_DOMAIN"><select value={domain} onChange={(e) => setDomain(e.target.value)}><option value="feishu">飞书中国 · feishu</option><option value="lark">Lark 国际 · lark</option></select></Field>
              <Field label="连接模式" desc="桌面端默认 WebSocket，无需公网地址。" meta="FEISHU_CONNECTION_MODE"><select value={connectionMode} onChange={(e) => setConnectionMode(e.target.value)}><option value="websocket">WebSocket（推荐）</option><option value="webhook">Webhook（高级）</option></select></Field>
              <Field label="App ID" desc="来自飞书开放平台的应用凭证。" meta="FEISHU_APP_ID"><input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="cli_xxx" /></Field>
              <Field label="App Secret" desc="敏感凭据，仅用于保存到当前 profile。" meta="FEISHU_APP_SECRET"><input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="••••••••" /></Field>
              {connectionMode === "webhook" && <>
                <Field label="Webhook Host" desc="仅 Webhook 模式需要。" meta="FEISHU_WEBHOOK_HOST"><input value={webhookHost} onChange={(e) => setWebhookHost(e.target.value)} /></Field>
                <Field label="Webhook Port" desc="本地 handler 端口。" meta="FEISHU_WEBHOOK_PORT"><input value={webhookPort} onChange={(e) => setWebhookPort(e.target.value)} /></Field>
                <Field label="Webhook Path" desc="开放平台回调路径。" meta="FEISHU_WEBHOOK_PATH"><input value={webhookPath} onChange={(e) => setWebhookPath(e.target.value)} /></Field>
                <Field label="Webhook 安全" desc="Encrypt Key，可留空后续补充。" meta="FEISHU_ENCRYPT_KEY"><input type="password" value={encryptKey} onChange={(e) => setEncryptKey(e.target.value)} /></Field>
                <Field label="Verification Token" desc="签名校验 token。" meta="FEISHU_VERIFICATION_TOKEN"><input type="password" value={verificationToken} onChange={(e) => setVerificationToken(e.target.value)} /></Field>
              </>}
              <div className={s.sectionActions}><button className={`${s.btn} ${s.externalBtn}`} onClick={() => openExternal(FEISHU_DEVELOPER_URL)}><ExternalLink size={14} />打开飞书开发者后台</button></div>
            </section>
          </>}

          <SectionTitle num="[ STEP 03 ]" title="保存本地策略并启动 Gateway" meta="这一步只写入当前 profile，不代表飞书后台已经可聊天" />
          <section className={s.section}>
            <div className={s.policyGrid}>
              <PolicyCard active={dmPolicy === "pairing"} title="私聊配对审批" desc="未知用户可发起请求，由管理员批准。" onClick={() => setDmPolicy("pairing")} />
              <PolicyCard active={dmPolicy === "allowlist"} title="指定 open_id 白名单" desc="只允许列表中的成员触发。" onClick={() => setDmPolicy("allowlist")} />
              <PolicyCard active={dmPolicy === "open"} warning title="允许所有私聊" desc="最快试用，但风险更高。" onClick={() => setDmPolicy("open")} />
            </div>
            {dmPolicy === "allowlist" && <Field label="允许用户" desc="多个 open_id 用英文逗号分隔。" meta="FEISHU_ALLOWED_USERS"><input value={allowedUsers} onChange={(e) => setAllowedUsers(e.target.value)} /></Field>}
            <Field label="群聊策略" desc="减少噪声，默认仅 @Hermes 时响应。" meta="FEISHU_GROUP_POLICY"><select value={groupPolicy} onChange={(e) => setGroupPolicy(e.target.value as FeishuGroupPolicy)}><option value="mention">启用群聊，仅 @Hermes 时响应</option><option value="disabled">禁用群聊</option></select></Field>
            <Field label="通知 Home Channel" desc="用于 cron 和跨平台通知，可稍后设置。" meta="FEISHU_HOME_CHANNEL"><input value={homeChannel} onChange={(e) => setHomeChannel(e.target.value)} placeholder="oc_xxx 或留空" /></Field>
          </section>

          <SectionTitle num="[ REVIEW ]" title="保存前配置摘要" meta="secret 只显示脱敏摘要；保存后继续配置飞书后台" />
          {credential && <div className={s.summaryLine}>扫码结果：App ID {last(credential.appId)} · App Secret {last(credential.appSecret)} · Bot {credential.botName ?? "未探测"}</div>}
          <ReviewTable rows={rows} />
          <div className={s.sectionActions}><button className={`${s.btn} ${s.primary}`} onClick={save} disabled={busy || !(canApplyQr || canApplyManual)}><Save size={14} />保存并重启 Gateway</button></div>
          <ApplyResult result={result} />
          <SectionTitle num="[ STEP 04 ]" title="配置飞书后台权限与事件" meta="必须完成接收消息 v2.0、权限开通和版本发布" />
          <FeishuBackendChecklist />
          <SectionTitle num="[ STEP 05 ]" title="发送测试消息" meta="用私聊和群聊 @ 验证真正可聊天" />
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
  const [groupPolicy, setGroupPolicy] = useState<WeixinGroupPolicy>("disabled");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [groupAllowed, setGroupAllowed] = useState("");
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
    WEIXIN_GROUP_POLICY: groupPolicy,
    WEIXIN_GROUP_ALLOWED_USERS: groupPolicy === "allowlist" ? groupAllowed.replaceAll(" ", "") : "",
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
    ["私聊策略", `WEIXIN_DM_POLICY=${dmPolicy}`, "推荐 pairing"],
    ["允许所有用户", `WEIXIN_ALLOW_ALL_USERS=${dmPolicy === "open" ? "true" : "false"}`, "安全默认"],
    ["群聊策略", `WEIXIN_GROUP_POLICY=${groupPolicy}`, groupPolicy === "disabled" ? "推荐" : "高级"],
  ];

  return (
    <SectionShell title="消息平台接入 · 微信" sub="02 配置 / 023 消息平台接入" rail={<Rail platform="weixin" />} railLabel="微信接入诊断边栏">
      <div className={s.wrap}>
        <main className={s.mainCol}>
          <Hero platform="weixin" stateSub={`当前 profile：${stateQuery.data?.currentProfile ?? "default"}`} onPrimary={start} primaryBusy={busy} />
          <ActionFeedback busy={begin.isPending} error={begin.error} flow={flow} status={status} onJump={jumpToQr} />
          <MetaStrip platform="weixin" profile={stateQuery.data?.currentProfile ?? "default"} statusData={statusQuery.data} configured={configured} />
          <FlowSteps platform="weixin" status={status} saved={Boolean(result?.ok)} />
          <SectionTitle num="[ STEP 01 ]" title="运行环境检查" meta="微信需要 aiohttp、cryptography 与唯一 token poller" />
          <section className={s.section}><div className={s.verifyGrid}>
            <div className={s.verifyRow}><ShieldCheck size={16} /><div><b>Gateway 状态</b><small>{statusQuery.data?.gateway_running ? "当前 Gateway 可重启。" : "Gateway 未运行，保存后会尝试重启。"}</small></div></div>
            <div className={s.verifyRow}><KeyRound size={16} /><div><b>账号配置</b><small>{configured.WEIXIN_ACCOUNT_ID?.isSet ? `已保存 ${last(configured.WEIXIN_ACCOUNT_ID)}` : "尚未绑定 iLink bot。"}</small></div></div>
          </div></section>
          <div ref={qrAnchorRef} className={s.anchorBlock}>
            <SectionTitle num="[ STEP 02 ]" title="微信扫码绑定 iLink bot" meta="默认 8 分钟超时，二维码过期后最多自动刷新 3 次" />
            <QrPanel data={pollResult?.qrScanData ?? flow?.qrScanData} url={pollResult?.qrUrl ?? flow?.qrUrl} status={status} message={pollResult?.message ?? flow?.message} />
          </div>
          <div className={s.sectionActions}><button className={`${s.btn} ${s.primary}`} onClick={start} disabled={busy}><ScanLine size={14} />生成二维码</button><button className={s.btn} onClick={pollOnce} disabled={!flow || busy}><RotateCw size={14} />立即检查</button></div>
          <SectionTitle num="[ STEP 03 ]" title="凭据与高级连接配置" meta="普通用户无需手填 token，扫码成功后自动写入" />
          <section className={s.section}>
            <Field label="Account ID" desc="扫码成功后自动得到，也可用于恢复已有配置。" meta="WEIXIN_ACCOUNT_ID"><input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder={last(credential?.accountId)} /></Field>
            <Field label="Bot Token" desc="敏感凭据，仅保存到当前 profile。" meta="WEIXIN_TOKEN"><input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={last(credential?.token)} /></Field>
            <Field label="iLink API" desc="默认不需要修改。" meta="WEIXIN_BASE_URL"><input value={credential?.baseUrl ?? baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></Field>
            <Field label="CDN Base" desc="媒体加密上传与下载使用。" meta="WEIXIN_CDN_BASE_URL"><input value={cdnBaseUrl} onChange={(e) => setCdnBaseUrl(e.target.value)} /></Field>
          </section>
          <SectionTitle num="[ STEP 04 ]" title="访问策略" meta="默认私聊配对审批，群聊保持关闭" />
          <section className={s.section}>
            <div className={s.policyGrid}>
              <PolicyCard active={dmPolicy === "pairing"} title="私聊配对审批" desc="未知用户私聊时生成 pairing code。" onClick={() => setDmPolicy("pairing")} />
              <PolicyCard active={dmPolicy === "allowlist"} title="指定用户 ID" desc="只允许 WEIXIN_ALLOWED_USERS 中的用户。" onClick={() => setDmPolicy("allowlist")} />
              <PolicyCard active={dmPolicy === "open"} warning title="允许所有私聊" desc="试用最快，但访问面最大。" onClick={() => setDmPolicy("open")} />
            </div>
            {dmPolicy === "allowlist" && <Field label="允许用户" desc="多个用户 ID 用英文逗号分隔。" meta="WEIXIN_ALLOWED_USERS"><input value={allowedUsers} onChange={(e) => setAllowedUsers(e.target.value)} /></Field>}
            <Field label="群聊策略" desc="iLink bot 身份通常收不到普通微信群事件。" meta="WEIXIN_GROUP_POLICY"><select value={groupPolicy} onChange={(e) => setGroupPolicy(e.target.value as WeixinGroupPolicy)}><option value="disabled">禁用群聊（推荐）</option><option value="open">允许所有群聊（仅 iLink 实际投递时有效）</option><option value="allowlist">仅允许指定群聊 ID</option></select></Field>
            {groupPolicy === "allowlist" && <Field label="允许群聊" desc="填写群聊 ID，不是成员用户 ID。" meta="WEIXIN_GROUP_ALLOWED_USERS"><input value={groupAllowed} onChange={(e) => setGroupAllowed(e.target.value)} /></Field>}
            <Field label="Home Channel" desc="用于 cron 和通知，可先用扫码返回 user_id。" meta="WEIXIN_HOME_CHANNEL"><input value={homeChannel} onChange={(e) => setHomeChannel(e.target.value)} placeholder="wxid_xxx / filehelper / user_id" /></Field>
          </section>
          <SectionTitle num="[ REVIEW ]" title="将写入的配置摘要" meta="token 永远只显示脱敏摘要" />
          <ReviewTable rows={rows} />
          <div className={s.sectionActions}><button className={`${s.btn} ${s.primary}`} onClick={save} disabled={busy || !(canApplyQr || canApplyManual)}><Save size={14} />保存并重启 Gateway</button></div>
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
