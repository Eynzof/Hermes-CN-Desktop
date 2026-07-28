// 「编程Agent」设置分区（P-047 委派可视化的检测与指引面）。
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
import { Button, LoadingState } from "@hermes/shared-ui";
import { CopyButton } from "@/components/ui/copy-button";
import { DiagnosticCopyButton } from "@/components/ui/diagnostic-copy-button";
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
  if (status === "ok") return <CheckCircle2 size={12} />;
  if (status === "error") return <XCircle size={12} />;
  if (status === "warning") return <AlertTriangle size={12} />;
  return <CircleHelp size={12} />;
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

export function DelegationSkillControl({ agent, skill, onToggle, pending }: {
  agent: CodingAgentStatus;
  skill: SkillInfo | undefined;
  onToggle: (name: string, enabled: boolean) => void;
  pending: boolean;
}) {
  if (!skill) {
    return (
      <div
        className={s.delegationSkillControl}
        data-delegation-skill="true"
        data-state="missing"
        role="status"
      >
        <span className={s.delegationSkillIcon} aria-hidden>
          <AlertTriangle size={16} />
        </span>
        <div className={s.delegationSkillBody}>
          <div className={s.delegationSkillMeta}>
            <span className={s.delegationSkillEyebrow}>委派技能</span>
            <span className={s.envStatusTag} data-status="warning">未找到</span>
          </div>
          <code className={s.delegationSkillName}>{agent.skillName}</code>
          <p className={s.delegationSkillDescription}>
            当前内核未提供此技能。请升级或重新同步内核技能后再试。
          </p>
        </div>
      </div>
    );
  }

  const state = skill.enabled ? "enabled" : "disabled";
  return (
    <div
      className={s.delegationSkillControl}
      data-delegation-skill="true"
      data-state={state}
      role="group"
      aria-label={`${agent.label} 委派技能`}
    >
      <span className={s.delegationSkillIcon} aria-hidden>
        <Bot size={16} />
      </span>
      <div className={s.delegationSkillBody}>
        <div className={s.delegationSkillMeta}>
          <span className={s.delegationSkillEyebrow}>委派技能</span>
          <span className={s.envStatusTag} data-status={skill.enabled ? "ok" : "warning"}>
            {skill.enabled ? "已启用" : "已停用"}
          </span>
        </div>
        <code className={s.delegationSkillName}>{skill.name}</code>
        <p className={s.delegationSkillDescription}>
          {skill.enabled
            ? `Hermes 会通过此技能把编码任务交给 ${agent.label}。`
            : `启用后，Hermes 才能把编码任务交给 ${agent.label}。`}
        </p>
      </div>
      <button
        className={[s.btn, s.delegationSkillAction].join(" ")}
        type="button"
        disabled={pending}
        onClick={() => onToggle(skill.name, !skill.enabled)}
      >
        {pending ? "处理中…" : skill.enabled ? "停用技能" : "启用技能"}
      </button>
    </div>
  );
}

export function CodingAgentToolbar({ isFetching, hasBridge, onRefresh, diagnostics }: {
  isFetching: boolean;
  hasBridge: boolean;
  onRefresh: () => void;
  diagnostics: () => string;
}) {
  return (
    <div className={s.codingAgentToolbar} role="toolbar" aria-label="编程Agent 操作">
      <Button
        className={s.codingAgentToolbarButton}
        variant="outline"
        size="md"
        type="button"
        data-coding-agent-action="true"
        onClick={onRefresh}
        disabled={!hasBridge}
        loading={isFetching}
        leadingIcon={<RefreshCw size={12} />}
      >
        刷新检测
      </Button>
      <DiagnosticCopyButton
        className={s.codingAgentToolbarButton}
        data-coding-agent-action="true"
        text={diagnostics}
      />
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
    <section className={s.codingAgentCard} data-coding-agent-card="true">
      <header className={s.codingAgentCardHeader}>
        <div className={s.codingAgentIdentity}>
          <div className={s.debugCardIcon}>
            <SquareTerminal size={16} />
          </div>
          <div className={s.codingAgentIdentityText}>
            <h3>{agent.label}</h3>
            <p>{agent.id === "claude-code" ? "Anthropic 自主编程Agent CLI" : "OpenAI 自主编程Agent CLI"}</p>
          </div>
        </div>
        <div className={s.codingAgentStatusGroup} aria-label={`${agent.label} 当前状态`}>
          <span className={s.envStatusTag} data-status={status}>
            <StatusIcon status={status} />
            {agent.installed ? "已安装" : "未安装"}
          </span>
          {agent.installed ? (
            <span className={s.envStatusTag} data-status={agent.loginState === "logged_in" ? "ok" : status}>
              <KeyRound size={12} aria-hidden />
              {LOGIN_LABELS[agent.loginState]}
            </span>
          ) : null}
        </div>
      </header>

      <div className={[s.envCheckItem, s.codingAgentDetails].join(" ")} data-status={status}>
        <p className={s.envCheckSummary} data-status={status}>{agentStatusLine(agent)}</p>

        <div className={[s.runtimeGrid, s.envCheckDetails, s.codingAgentRuntimeGrid].join(" ")}>
          {agent.installed && agent.version ? <RuntimeField label="版本" value={agent.version} mono /> : null}
          {agent.loginDetail ? <RuntimeField label="登录状态" value={agent.loginDetail} /> : null}
          {agent.installed && agent.path ? <RuntimeField label="路径" value={agent.path} mono wide /> : null}
          <RuntimeField label="配置目录" value={agent.configDir} mono wide />
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
            <FolderOpen size={12} />
            打开路径
          </button>
        ) : null}
      </div>

      <DelegationSkillControl
        agent={agent}
        skill={skill}
        onToggle={onToggle}
        pending={togglePending}
      />
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
    <div className={s.codingAgentsPage}>
      {showHeading && <h2 className={s.heading}>编程Agent</h2>}
      <div
        className={[s.aboutHero, s.codingAgentsHero].join(" ")}
        data-ok={allReady && data ? "true" : undefined}
      >
        <div className={s.aboutHeroMark}>
          <SquareTerminal size={24} />
        </div>
        <div className={s.aboutHeroBody}>
          <div className={s.aboutEyebrow}>多 Agent 协作 · CLI 委派</div>
          <h3>
            {data
              ? allReady
                ? "编程Agent 就绪，Hermes 可以调度它们干活"
                : "部分编程Agent 未就绪"
              : "正在检测编程Agent"}
          </h3>
          <p>
            Hermes 可以通过内置技能把编码任务委派给本机的 Claude Code 与 Codex CLI，
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

      <CodingAgentToolbar
        isFetching={query.isFetching}
        hasBridge={hasBridge}
        onRefresh={() => void query.refetch()}
        diagnostics={diagnostics}
      />

      {!hasBridge && (
        <div className={s.runtimeMessage} data-tone="error">
          当前运行环境不支持编程Agent 检测（需要桌面端）。
        </div>
      )}
      {query.isError && (
        <div className={s.runtimeMessage} data-tone="error">
          检测失败：{query.error instanceof Error ? query.error.message : "unknown error"}
        </div>
      )}

      {data && (
        <div className={s.codingAgentList}>
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

      {!data && query.isLoading && <LoadingState variant="block" label="正在检测本机编程 Agent…" />}
    </div>
  );
}
