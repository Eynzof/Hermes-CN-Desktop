import { useMemo, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Copy,
  FolderOpen,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useStatus } from "@/hooks/use-status";
import { useConfig, useModelInfo } from "@/hooks/use-config";
import { useEnvVars } from "@/hooks/use-env";
import { useSkills } from "@/hooks/use-skills";
import { useMcpServers } from "@/hooks/use-mcp-servers";
import { useLastUsedModel } from "@/lib/last-used-model";
import { CopyButton } from "@/components/ui/copy-button";
import { Dot } from "@/components/ui/pill";
import s from "./health-grid.module.css";

const DEFAULT_DESKTOP_DASHBOARD_ORIGIN = "127.0.0.1:9120";
const TOKEN_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GLM_API_KEY", "DEEPSEEK_API_KEY"];

type Tone = "ok" | "warn" | "err";
type HealthVariant = "compact" | "page";
type HealthGroup = "runtime" | "model" | "extensions";

interface HealthGridProps {
  variant?: HealthVariant;
}

interface HealthItem {
  id: string;
  group: HealthGroup;
  label: string;
  tone: Tone;
  value: string;
  sub?: string;
  detail?: string;
  mono?: boolean;
  title?: string;
  actionTo?: string;
  actionLabel?: string;
}

interface HealthMetric {
  label: string;
  value: string;
  sub: string;
  tone: Tone;
}

function formatContextLength(n: number | undefined | null): string {
  if (!n || n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M ctx`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k ctx`;
  return `${n} ctx`;
}

function originFromHealthUrl(url: string | null | undefined): string {
  if (!url) return DEFAULT_DESKTOP_DASHBOARD_ORIGIN;
  try {
    return new URL(url).host || DEFAULT_DESKTOP_DASHBOARD_ORIGIN;
  } catch {
    return DEFAULT_DESKTOP_DASHBOARD_ORIGIN;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toneLabel(tone: Tone): string {
  if (tone === "ok") return "正常";
  if (tone === "warn") return "注意";
  return "异常";
}

function toneIcon(tone: Tone, size = 16): ReactNode {
  if (tone === "ok") return <CheckCircle2 size={size} />;
  if (tone === "warn") return <AlertTriangle size={size} />;
  return <XCircle size={size} />;
}

function groupTitle(group: HealthGroup): string {
  if (group === "runtime") return "运行时与路径";
  if (group === "model") return "模型与凭证";
  return "扩展能力";
}

function groupSub(group: HealthGroup): string {
  if (group === "runtime") return "Dashboard、Gateway 与本地 Hermes 数据目录。";
  if (group === "model") return "默认模型、API Token 与 provider 字段校验。";
  return "Skills、MCP 以及会话扩展能力。";
}

function groupIcon(group: HealthGroup): ReactNode {
  if (group === "runtime") return <ServerCog size={15} />;
  if (group === "model") return <SlidersHorizontal size={15} />;
  return <Sparkles size={15} />;
}

function groupTone(items: HealthItem[]): Tone {
  if (items.some((item) => item.tone === "err")) return "err";
  if (items.some((item) => item.tone === "warn")) return "warn";
  return "ok";
}

function providerMap(config: Record<string, unknown> | undefined): Record<string, unknown> {
  const providers = config?.providers;
  return isRecord(providers) ? providers : {};
}

function findInvalidProviderApiKeys(providers: Record<string, unknown>): string[] {
  const invalid: string[] = [];
  for (const [name, cfg] of Object.entries(providers)) {
    if (!isRecord(cfg)) continue;
    const key = typeof cfg.api_key === "string" ? cfg.api_key.trim() : "";
    if (key && /^https?:\/\//i.test(key)) invalid.push(name);
  }
  return invalid;
}

function formatTokenNames(keys: string[]): string {
  return keys.map((key) => key.toLowerCase().replace(/_api_key/g, "")).join(" · ");
}

function healthDigestText(counts: { ok: number; warn: number; err: number }, total: number): string {
  const parts = [`${counts.ok}/${total} 项正常`];
  if (counts.warn > 0) parts.push(`${counts.warn} 项注意`);
  if (counts.err > 0) parts.push(`${counts.err} 项异常`);
  return parts.join(" · ");
}

function buildDiagnosticsPayload(input: {
  status: ReturnType<typeof useStatus>["data"];
  modelInfo: ReturnType<typeof useModelInfo>["data"];
  env: ReturnType<typeof useEnvVars>["data"];
  skills: ReturnType<typeof useSkills>["data"];
  mcp: ReturnType<typeof useMcpServers>["data"];
  providerTotal: number;
  invalidProviders: string[];
  counts: { ok: number; warn: number; err: number };
}) {
  const envSummary = input.env
    ? Object.fromEntries(
        Object.entries(input.env).map(([key, info]) => [
          key,
          {
            is_set: info.is_set,
            category: info.category,
            tools: info.tools,
          },
        ]),
      )
    : null;

  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      summary: input.counts,
      dashboard: input.status
        ? {
            version: input.status.version,
            hermes_home: input.status.hermes_home ?? null,
            config_path: input.status.config_path ?? null,
            env_path: input.status.env_path ?? null,
            gateway_running: input.status.gateway_running,
            gateway_state: input.status.gateway_state,
            gateway_health_url: input.status.gateway_health_url,
            active_sessions: input.status.active_sessions,
          }
        : null,
      model: input.modelInfo ?? null,
      env: envSummary,
      skills: input.skills
        ? {
            total: input.skills.length,
            enabled: input.skills.filter((skill) => skill.enabled).length,
          }
        : null,
      mcp: input.mcp?.summary ?? null,
      providers: {
        total: input.providerTotal,
        invalidApiKeyLooksLikeUrl: input.invalidProviders,
      },
    },
    null,
    2,
  );
}

function HealthItemCard({ item, onNavigate }: { item: HealthItem; onNavigate: (to: string) => void }) {
  const title = item.title ?? [item.value, item.sub, item.detail].filter(Boolean).join(" · ");
  const content = (
    <>
      <div className={s.itemTop}>
        <span className={s.itemLabel}>{item.label}</span>
        <span className={s.itemTone} data-tone={item.tone}>{toneLabel(item.tone)}</span>
      </div>
      <div className={s.itemValue} data-mono={item.mono ? "true" : undefined}>{item.value}</div>
      {item.sub && <div className={s.itemSub}>{item.sub}</div>}
      {item.detail && <p className={s.itemDetail}>{item.detail}</p>}
      {item.actionTo && (
        <span className={s.itemAction}>
          {item.actionLabel ?? "去处理"}
          <ArrowRight size={13} aria-hidden="true" />
        </span>
      )}
    </>
  );

  if (item.actionTo) {
    const actionTo = item.actionTo;
    return (
      <button
        type="button"
        className={s.item}
        data-tone={item.tone}
        data-action="true"
        title={title}
        aria-label={`${item.label}: ${item.value}${item.sub ? `，${item.sub}` : ""}`}
        onClick={() => onNavigate(actionTo)}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={s.item} data-tone={item.tone} title={title}>
      {content}
    </div>
  );
}

function MetricCard({ metric }: { metric: HealthMetric }) {
  return (
    <div className={s.metric} data-tone={metric.tone}>
      <div className={s.metricLabel}>{metric.label}</div>
      <div className={s.metricValue}>{metric.value}</div>
      <div className={s.metricSub}>{metric.sub}</div>
    </div>
  );
}

export function HealthGrid({ variant = "compact" }: HealthGridProps) {
  const navigate = useNavigate();
  const statusQuery = useStatus();
  const modelInfoQuery = useModelInfo();
  const configQuery = useConfig();
  const envQuery = useEnvVars();
  const skillsQuery = useSkills();
  const mcpQuery = useMcpServers();
  const status = statusQuery.data;
  const modelInfo = modelInfoQuery.data;
  const config = configQuery.data;
  const env = envQuery.data;
  const skills = skillsQuery.data;
  const mcp = mcpQuery.data;
  const lastUsedModel = useLastUsedModel();

  const health = useMemo(() => {
    // `gateway_running` is the *PTY daemon* status — a Python subprocess
    // the dashboard *can* spawn for the embedded chat tab. With P-009
    // the SSE+POST transport calls tui_gateway.dispatch() in-process,
    // so the daemon stays "stopped" by design and that's fine. The real
    // health signal is whether the dashboard responded to /api/status.
    const dashboardReachable = !!status;
    const daemonRunning = status?.gateway_running === true;
    const gatewayState = status?.gateway_state || (daemonRunning ? "running" : "stopped");
    const dashboardOrigin = originFromHealthUrl(status?.gateway_health_url);

    const setTokens = env ? TOKEN_KEYS.filter((key) => env[key]?.is_set) : [];
    const anyTokenSet = setTokens.length > 0;

    const modelName = lastUsedModel?.model || modelInfo?.model || "—";
    const ctxLabel = formatContextLength(
      lastUsedModel?.contextWindow
        ?? modelInfo?.effective_context_length
        ?? modelInfo?.auto_context_length,
    );

    const skillsTotal = skills?.length ?? 0;
    const skillsEnabled = skills?.filter((skill) => skill.enabled).length ?? 0;
    const mcpTotal = mcp?.summary.total ?? 0;
    const mcpEnabled = mcp?.summary.enabled ?? 0;

    const providers = providerMap(config);
    const invalidProviders = findInvalidProviderApiKeys(providers);
    const providerTotal = Object.keys(providers).length;
    const providersOk = providerTotal > 0 && invalidProviders.length === 0;

    const items: HealthItem[] = [
      {
        id: "gateway",
        group: "runtime",
        label: "Dashboard / Gateway",
        tone: statusQuery.isError ? "err" : dashboardReachable ? "ok" : "warn",
        value: dashboardOrigin,
        sub: statusQuery.isError
          ? "状态接口未响应"
          : dashboardReachable
            ? daemonRunning
              ? "Gateway daemon 运行中"
              : "Dashboard 就绪 · in-process dispatch"
            : "正在连接",
        detail: dashboardReachable
          ? "聊天传输走 dashboard 的 /api/ws WebSocket（进程内 dispatch）；gateway_state=stopped 不等同于不可用。"
          : "如果长时间停留在连接中，请确认 managed runtime 已启动，或在状态栏执行 Gateway 重启。",
        mono: true,
        title: `dashboardReachable=${dashboardReachable}; gateway_state=${gatewayState}. /api/ws 在 dashboard 进程内 dispatch，gateway_state=stopped 是预期值。`,
      },
      {
        id: "home",
        group: "runtime",
        label: "Hermes Home",
        tone: status?.hermes_home ? "ok" : "warn",
        value: status?.hermes_home || "—",
        sub: status?.hermes_home ? "数据目录已识别" : "等待 /api/status 返回路径",
        detail: status?.config_path || status?.env_path
          ? `配置：${status?.config_path ?? "—"}；环境变量：${status?.env_path ?? "—"}`
          : "这是桌面端当前 profile 的配置、会话和环境变量根目录。",
        mono: true,
      },
      {
        id: "model",
        group: "model",
        label: "默认模型",
        tone: modelName !== "—" ? "ok" : "warn",
        value: modelName,
        sub: modelName !== "—" ? ctxLabel : "尚未选择可用模型",
        detail: modelName !== "—"
          ? `Provider：${lastUsedModel?.providerName ?? lastUsedModel?.provider ?? modelInfo?.provider ?? "—"}`
          : "没有默认模型时，新任务可能无法直接发送。",
        mono: true,
        actionTo: modelName === "—" ? "/models" : undefined,
        actionLabel: "配置模型",
      },
      {
        id: "token",
        group: "model",
        label: "API Token",
        tone: envQuery.isError ? "err" : env ? (anyTokenSet ? "ok" : "warn") : "warn",
        value: envQuery.isError ? "读取失败" : env ? (anyTokenSet ? "已配置" : "未配置") : "检测中",
        sub: anyTokenSet ? formatTokenNames(setTokens) : "模型调用需要至少一个可用 Token",
        detail: anyTokenSet
          ? "仅展示已设置的变量名称，不会暴露密钥内容。"
          : "可在模型设置里补齐 Anthropic、OpenAI、GLM 或 DeepSeek 等服务商密钥。",
        actionTo: anyTokenSet ? undefined : "/models",
        actionLabel: "填写 Token",
      },
      {
        id: "provider",
        group: "model",
        label: "Provider 配置",
        tone: providersOk ? "ok" : "warn",
        value: providerTotal === 0
          ? "未配置"
          : invalidProviders.length > 0
            ? `${invalidProviders.length} / ${providerTotal} 异常`
            : `${providerTotal} 个有效`,
        sub: invalidProviders.length > 0
          ? `api_key 是 URL：${invalidProviders.join(", ")}`
          : providerTotal === 0
            ? "缺少 providers 配置"
            : "api_key 字段形态正常",
        detail: invalidProviders.length > 0
          ? "这些 provider 会把 URL 当作 Bearer token 发送，上游通常会返回 401。"
          : providerTotal === 0
            ? "选择服务商并保存模型后会自动写入 provider 配置。"
            : "已完成基础形态检查；真实额度与连通性仍以模型页探测结果为准。",
        actionTo: providerTotal === 0 || invalidProviders.length > 0 ? "/models" : undefined,
        actionLabel: "修正配置",
      },
      {
        id: "skills",
        group: "extensions",
        label: "Skills",
        tone: skillsQuery.isError ? "err" : skills ? (skillsEnabled > 0 ? "ok" : "warn") : "warn",
        value: skillsQuery.isError ? "读取失败" : skills ? `${skillsEnabled} 启用` : "检测中",
        sub: skills ? `共 ${skillsTotal} 个` : "正在读取 Skill 列表",
        detail: skillsEnabled > 0
          ? "新任务可通过 / 选择已启用 Skill。"
          : "未启用 Skill 不影响基础对话，但会降低任务模板和专长能力。",
      },
      {
        id: "mcp",
        group: "extensions",
        label: "MCP 服务",
        tone: mcpQuery.isError ? "err" : mcp ? (mcpTotal === 0 ? "warn" : "ok") : "warn",
        value: mcpQuery.isError ? "未接入" : mcp ? `${mcpEnabled} / ${mcpTotal}` : "检测中",
        sub: mcpQuery.isError ? "需重启 dashboard" : mcp ? (mcpTotal === 0 ? "未配置" : `共 ${mcpTotal} 个`) : "正在读取 MCP 列表",
        detail: mcpQuery.isError
          ? "Dashboard 没有返回 MCP 列表，通常由后端尚未加载或运行时状态过期导致。"
          : mcpTotal === 0
            ? "没有 MCP 不影响基础聊天；需要外部工具时再接入。"
            : "启用的 MCP 会作为外部工具能力参与任务执行。",
        mono: Boolean(mcp),
      },
    ];

    const counts = { ok: 0, warn: 0, err: 0 };
    for (const item of items) {
      counts[item.tone] += 1;
    }
    const overallTone: Tone = counts.err > 0 ? "err" : counts.warn > 0 ? "warn" : "ok";
    const summaryLabel = overallTone === "err"
      ? `${counts.err} 项异常`
      : overallTone === "warn"
        ? `${counts.warn} 项需要关注`
        : "系统正常";
    const summarySub = healthDigestText(counts, items.length);

    return {
      items,
      counts,
      overallTone,
      summaryLabel,
      summarySub,
      providerTotal,
      invalidProviders,
      metrics: [
        { label: "正常项", value: String(counts.ok), sub: `共 ${items.length} 项`, tone: "ok" as Tone },
        { label: "注意项", value: String(counts.warn), sub: counts.warn ? "建议尽快处理" : "无需处理", tone: counts.warn ? "warn" as Tone : "ok" as Tone },
        { label: "异常项", value: String(counts.err), sub: counts.err ? "影响功能可用性" : "未发现异常", tone: counts.err ? "err" as Tone : "ok" as Tone },
        { label: "活跃会话", value: String(status?.active_sessions ?? 0), sub: status ? `Dashboard v${status.version}` : "等待状态接口", tone: status ? "ok" as Tone : "warn" as Tone },
      ] satisfies HealthMetric[],
    };
  }, [config, env, envQuery.isError, lastUsedModel, mcp, mcpQuery.isError, modelInfo, skills, skillsQuery.isError, status, statusQuery.isError]);

  const isRefreshing = statusQuery.isFetching
    || modelInfoQuery.isFetching
    || configQuery.isFetching
    || envQuery.isFetching
    || skillsQuery.isFetching
    || mcpQuery.isFetching;

  const refreshAll = () => {
    void Promise.all([
      statusQuery.refetch(),
      modelInfoQuery.refetch(),
      configQuery.refetch(),
      envQuery.refetch(),
      skillsQuery.refetch(),
      mcpQuery.refetch(),
    ]);
  };

  const openHermesHome = () => {
    if (!status?.hermes_home || !window.hermesDesktop?.openWorkspacePath) return;
    void window.hermesDesktop.openWorkspacePath({ path: status.hermes_home }).catch(() => undefined);
  };

  const attentionItems = health.items.filter((item) => item.tone !== "ok");
  const groups: HealthGroup[] = ["runtime", "model", "extensions"];

  if (variant === "page") {
    return (
      <section className={s.root} data-variant="page">
        <div className={s.hero} data-tone={health.overallTone}>
          <div className={s.heroMark} data-tone={health.overallTone} aria-hidden="true">
            {toneIcon(health.overallTone, 24)}
          </div>
          <div className={s.heroBody}>
            <div className={s.eyebrow}>桌面端健康检查</div>
            <h2>{health.summaryLabel}</h2>
            <p>
              {status
                ? `Dashboard 已响应，当前版本 ${status.version}，活跃会话 ${status.active_sessions} 个。这里展示启动链路、模型凭证和扩展能力的实时诊断结果。`
                : statusQuery.isError
                  ? "无法读取 Dashboard 状态接口，优先检查 managed runtime 是否启动，以及本机端口是否被占用。"
                  : "正在读取 Dashboard 状态、模型配置、环境变量、Skills 与 MCP 服务。"}
            </p>
          </div>
          <div className={s.heroActions}>
            <button className={s.actionButton} type="button" onClick={refreshAll} disabled={isRefreshing}>
              <RefreshCw size={13} aria-hidden="true" />
              {isRefreshing ? "刷新中" : "刷新检查"}
            </button>
            <CopyButton
              className={s.actionButton}
              text={() => buildDiagnosticsPayload({
                status,
                modelInfo,
                env,
                skills,
                mcp,
                providerTotal: health.providerTotal,
                invalidProviders: health.invalidProviders,
                counts: health.counts,
              })}
            >
              <Copy size={13} aria-hidden="true" />
              复制诊断 JSON
            </CopyButton>
            <button
              className={s.actionButton}
              type="button"
              onClick={openHermesHome}
              disabled={!status?.hermes_home || !window.hermesDesktop?.openWorkspacePath}
            >
              <FolderOpen size={13} aria-hidden="true" />
              打开 HERMES_HOME
            </button>
          </div>
        </div>

        <div className={s.metrics}>
          {health.metrics.map((metric) => <MetricCard key={metric.label} metric={metric} />)}
        </div>

        <div className={s.pageGrid}>
          <div className={s.groups}>
            {groups.map((group) => {
              const groupItems = health.items.filter((item) => item.group === group);
              const tone = groupTone(groupItems);
              return (
                <section className={s.group} key={group} data-tone={tone}>
                  <div className={s.groupHead}>
                    <div className={s.groupIcon} data-tone={tone} aria-hidden="true">{groupIcon(group)}</div>
                    <div>
                      <h3>{groupTitle(group)}</h3>
                      <p>{groupSub(group)}</p>
                    </div>
                    <span className={s.groupStatus} data-tone={tone}>{toneLabel(tone)}</span>
                  </div>
                  <div className={s.itemGrid}>
                    {groupItems.map((item) => <HealthItemCard key={item.id} item={item} onNavigate={navigate} />)}
                  </div>
                </section>
              );
            })}
          </div>

          <aside className={s.aside} aria-label="健康检查建议">
            <div className={s.asideCard}>
              <div className={s.asideHead}>
                <Wrench size={15} aria-hidden="true" />
                <span>建议处理顺序</span>
              </div>
              {attentionItems.length > 0 ? (
                <div className={s.fixList}>
                  {attentionItems.map((item) => (
                    <button
                      key={item.id}
                      className={s.fixItem}
                      type="button"
                      data-tone={item.tone}
                      onClick={() => item.actionTo ? navigate(item.actionTo) : undefined}
                      disabled={!item.actionTo}
                    >
                      <span className={s.fixIcon} aria-hidden="true">{toneIcon(item.tone, 14)}</span>
                      <span className={s.fixText}>
                        <strong>{item.label}</strong>
                        <span>{item.sub ?? item.value}</span>
                      </span>
                      {item.actionTo && <ArrowRight size={13} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              ) : (
                <div className={s.emptyState}>
                  <ShieldCheck size={18} aria-hidden="true" />
                  <span>当前没有需要处理的健康项，可以直接新建任务。</span>
                </div>
              )}
            </div>

            <div className={s.asideCard}>
              <div className={s.asideHead}>
                <Activity size={15} aria-hidden="true" />
                <span>刷新节奏</span>
              </div>
              <p className={s.asideText}>
                `/api/status` 会自动轮询，其它配置项在进入页面和手动刷新时读取。这里不会再折叠隐藏详情，避免排查问题时漏看异常项。
              </p>
            </div>
          </aside>
        </div>
      </section>
    );
  }

  return (
    <section className={s.root} data-variant="compact">
      <div className={s.compactHead} data-tone={health.overallTone}>
        <div className={s.compactMain}>
          <Dot tone={health.overallTone} />
          <span className={s.compactTitle}>{health.summaryLabel}</span>
          <span className={s.compactSub}>{health.summarySub}</span>
        </div>
        <span className={s.compactMeta}>实时状态</span>
      </div>
      <div className={s.itemGrid}>
        {health.items.map((item) => <HealthItemCard key={item.id} item={item} onNavigate={navigate} />)}
      </div>
    </section>
  );
}
