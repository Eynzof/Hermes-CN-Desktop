// 「编码代理」设置分区（P-047 委派可视化的检测与指引面）。
//
// 检测 Claude Code / Codex CLI 的安装、版本与登录态（Rust coding_agents.rs，
// 不读任何 token 密文），联动 hermes 侧委派技能的启停（/api/skills）。
// 边界：本页只做检测 + 指引，不代写 ~/.claude / ~/.codex 配置文件——
// 多账号与中转切换请使用 cc-switch。
import { useMemo, type ReactNode } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleHelp,
  Copy,
  FolderOpen,
  KeyRound,
  RefreshCw,
  SquareTerminal,
  XCircle,
} from "lucide-react";
import type { CodingAgentStatus, SkillInfo } from "@hermes/protocol";
import { CopyButton } from "@/components/ui/copy-button";
import { useCodingAgentsCheck } from "@/hooks/use-coding-agents";
import { useSkills, useToggleSkill } from "@/hooks/use-skills";
import s from "./settings.module.css";

type CardStatus = "ok" | "warning" | "error" | "unknown";

const LOGIN_LABELS: Record<CodingAgentStatus["loginState"], string> = {
  logged_in: "已登录",
  expired: "凭据过期",
  not_logged_in: "未登录",
  unknown: "未知",
};

function agentCardStatus(agent: CodingAgentStatus): CardStatus {
  if (!agent.installed) return "warning";
  if (agent.loginState === "expired" || agent.loginState === "not_logged_in") return "warning";
  if (agent.loginState === "unknown") return "unknown";
  return "ok";
}

function agentStatusLine(agent: CodingAgentStatus): string {
  if (!agent.installed) {
    return `${agent.label} 未安装；hermes 无法把编码任务委派给它`;
  }
  if (agent.loginState === "logged_in") {
    return `${agent.label} 可用，hermes 可通过「${agent.skillName}」技能委派编码任务`;
  }
  if (agent.loginState === "expired") {
    return `${agent.label} 已安装，但登录凭据已过期`;
  }
  if (agent.loginState === "not_logged_in") {
    return `${agent.label} 已安装，但尚未登录`;
  }
  return `${agent.label} 已安装（登录状态无法确认，不影响使用）`;
}

function StatusIcon({ status }: { status: CardStatus }) {
  if (status === "ok") return <CheckCircle2 size={13} />;
  if (status === "error") return <XCircle size={13} />;
  if (status === "warning") return <AlertTriangle size={13} />;
  return <CircleHelp size={13} />;
}

function RuntimeField({ label, value, mono, wide }: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={s.runtimeField} data-wide={wide ? "true" : undefined}>
      <span>{label}</span>
      <b data-mono={mono ? "true" : undefined}>{value ?? "—"}</b>
    </div>
  );
}

function SkillRow({ agent, skill, onToggle, pending }: {
  agent: CodingAgentStatus;
  skill: SkillInfo | undefined;
  onToggle: (name: string, enabled: boolean) => void;
  pending: boolean;
}) {
  if (!skill) {
    return (
      <p className={s.desc}>
        内核里未找到「{agent.skillName}」技能——内核版本过旧或技能未同步；升级内核后重试。
      </p>
    );
  }
  return (
    <div className={s.envCheckHeader}>
      <div className={s.envCheckTitle}>
        <Bot size={13} aria-hidden />
        <span className={s.envCheckLabel}>hermes 委派技能「{skill.name}」</span>
        <span className={s.envStatusTag} data-status={skill.enabled ? "ok" : "warning"}>
          {skill.enabled ? "已启用" : "已停用"}
        </span>
      </div>
      <button
        className={s.btn}
        type="button"
        disabled={pending}
        onClick={() => onToggle(skill.name, !skill.enabled)}
      >
        {pending ? "处理中…" : skill.enabled ? "停用技能" : "启用技能"}
      </button>
    </div>
  );
}

function AgentCard({ agent, skill, onToggle, togglePending, onOpenPath }: {
  agent: CodingAgentStatus;
  skill: SkillInfo | undefined;
  onToggle: (name: string, enabled: boolean) => void;
  togglePending: boolean;
  onOpenPath: (path: string | undefined) => Promise<void>;
}) {
  const status = agentCardStatus(agent);
  return (
    <section className={s.debugCard} data-wide="true">
      <div className={s.debugCardHeader}>
        <div className={s.debugCardIcon}>
          <SquareTerminal size={15} />
        </div>
        <div>
          <h3>{agent.label}</h3>
          <p>{agent.id === "claude-code" ? "Anthropic 自主编码代理 CLI" : "OpenAI 自主编码代理 CLI"}</p>
        </div>
      </div>

      <div className={s.envCheckItem} data-status={status}>
        <div className={s.envCheckHeader}>
          <div className={s.envCheckTitle}>
            <span className={s.envCheckIcon} data-status={status}>
              <StatusIcon status={status} />
            </span>
            <span className={s.envCheckLabel}>{agent.installed ? "已安装" : "未安装"}</span>
            {agent.installed ? (
              <span className={s.envStatusTag} data-status={agent.loginState === "logged_in" ? "ok" : status}>
                <KeyRound size={11} aria-hidden /> {LOGIN_LABELS[agent.loginState]}
              </span>
            ) : null}
          </div>
        </div>
        <p className={s.envCheckSummary} data-status={status}>{agentStatusLine(agent)}</p>

        <div className={[s.runtimeGrid, s.envCheckDetails].join(" ")}>
          {agent.installed && agent.version ? <RuntimeField label="版本" value={agent.version} mono wide /> : null}
          {agent.installed && agent.path ? <RuntimeField label="路径" value={agent.path} mono wide /> : null}
          <RuntimeField label="配置目录" value={agent.configDir} mono wide />
          {agent.loginDetail ? <RuntimeField label="登录状态" value={agent.loginDetail} wide /> : null}
          {!agent.installed ? (
            <RuntimeField
              label="安装"
              value={
                <span>
                  <code>{agent.installHint}</code>{" "}
                  <CopyButton className={s.btn} text={agent.installHint}>
                    <Copy size={12} /> 复制命令
                  </CopyButton>
                </span>
              }
              wide
            />
          ) : null}
          {agent.installed && agent.loginState !== "logged_in" ? (
            <RuntimeField label="登录" value={agent.loginHint} wide />
          ) : null}
        </div>

        {agent.installed && agent.path && window.hermesDesktop?.openWorkspacePath ? (
          <button
            className={[s.btn, s.envOpenPathButton].join(" ")}
            type="button"
            onClick={() => void onOpenPath(agent.path)}
          >
            <FolderOpen size={13} />
            打开路径
          </button>
        ) : null}
      </div>

      <SkillRow agent={agent} skill={skill} onToggle={onToggle} pending={togglePending} />
    </section>
  );
}

export function CodingAgentsSection({ showHeading = true }: { showHeading?: boolean }) {
  const query = useCodingAgentsCheck();
  const data = query.data;
  const skillsQuery = useSkills();
  const toggleSkill = useToggleSkill();
  const hasBridge = typeof window !== "undefined" && Boolean(window.hermesDesktop?.codingAgentsCheck);

  const skillByName = useMemo(() => {
    const map = new Map<string, SkillInfo>();
    for (const skill of skillsQuery.data ?? []) map.set(skill.name, skill);
    return map;
  }, [skillsQuery.data]);

  const readyCount = (data?.agents ?? []).filter(
    (agent) => agent.installed && agent.loginState !== "expired" && agent.loginState !== "not_logged_in",
  ).length;
  const total = data?.agents.length ?? 2;
  const allReady = data ? readyCount === total : false;

  const openPath = async (path: string | undefined) => {
    if (!path || !window.hermesDesktop?.openWorkspacePath) return;
    await window.hermesDesktop.openWorkspacePath({ path }).catch(() => undefined);
  };

  const diagnostics = () =>
    JSON.stringify({ generatedAt: new Date().toISOString(), codingAgents: data ?? null }, null, 2);

  return (
    <div>
      {showHeading && <h2 className={s.heading}>编码代理</h2>}
      <div className={s.aboutHero} data-ok={allReady && data ? "true" : undefined}>
        <div className={s.aboutHeroMark}>
          <SquareTerminal size={24} />
        </div>
        <div className={s.aboutHeroBody}>
          <div className={s.aboutEyebrow}>多 Agent 协作 · CLI 委派</div>
          <h3>
            {data
              ? allReady
                ? "编码代理就绪，hermes 可以调度它们干活"
                : "部分编码代理未就绪"
              : "正在检测编码代理"}
          </h3>
          <p>
            hermes 可以通过内置技能把编码任务委派给本机的 Claude Code 与 Codex CLI，
            聊天中会以「委派卡片」实时展示它们的执行过程；侧栏「子Agent」面板可总览全部委派。
            本页只做检测与指引，不会改写 CLI 自身的配置文件（多账号/中转切换请使用 cc-switch）。
          </p>
        </div>
        <span
          className={s.statusBadge}
          data-on={allReady && data ? "true" : data && readyCount === 0 ? "false" : undefined}
        >
          {data ? `${readyCount}/${total} 就绪` : query.isLoading ? "检测中" : "未连接"}
        </span>
      </div>

      <div className={s.debugActionBar}>
        <button
          className={s.btn}
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching || !hasBridge}
        >
          <RefreshCw size={13} />
          {query.isFetching ? "检测中" : "刷新检测"}
        </button>
        <CopyButton className={s.btn} text={diagnostics}>
          <Copy size={13} />
          复制诊断 JSON
        </CopyButton>
      </div>

      {!hasBridge && (
        <div className={s.runtimeMessage} data-tone="error">
          当前运行环境不支持编码代理检测（需要桌面端）。
        </div>
      )}
      {query.isError && (
        <div className={s.runtimeMessage} data-tone="error">
          检测失败：{query.error instanceof Error ? query.error.message : "unknown error"}
        </div>
      )}

      {data && (
        <div className={s.aboutDebugGrid}>
          {data.agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              skill={skillByName.get(agent.skillName)}
              onToggle={(name, enabled) => toggleSkill.mutate({ name, enabled })}
              togglePending={toggleSkill.isPending}
              onOpenPath={openPath}
            />
          ))}
        </div>
      )}

      {!data && query.isLoading && <p className={s.desc}>正在检测本机编码代理…</p>}
    </div>
  );
}
