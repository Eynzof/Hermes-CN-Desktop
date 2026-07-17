import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { AlertCircle, Bot, CheckCircle2, ChevronRight, Loader2, SquareTerminal, X } from "lucide-react";
import { formatTokens } from "@/lib/format";
import {
  activeCliDelegationCount,
  cliDelegationsBySessionAtom,
  type CliDelegationEntry,
} from "@/stores/cli-delegations";
import {
  activeSubagentCount,
  buildSubagentTree,
  flattenSubagents,
  subagentsBySessionAtom,
  type SubagentNode,
  type SubagentProgress,
  type SubagentStatus,
  type SubagentStreamEntry,
} from "@/stores/subagents";
import { PanelResizeHandle, usePanelWidth } from "./panel-resize";
import s from "./subagent-panel.module.css";

// One persistent session id can surface under several gateway-session ids across
// resume/reconnect. The subagent store is keyed by the live event session_id, so
// we probe the candidate ids detail resolves and take the first non-empty hit.
export function useSessionSubagents(candidates: (string | undefined)[]): SubagentProgress[] {
  const bySession = useAtomValue(subagentsBySessionAtom);
  const key = candidates.filter(Boolean).join("|");
  return useMemo(() => {
    for (const id of candidates) {
      if (id && bySession[id]?.length) return bySession[id]!;
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bySession, key]);
}

/** 同 useSessionSubagents：按候选会话 id 读取外部 CLI 委派（P-047）。 */
export function useSessionCliDelegations(candidates: (string | undefined)[]): CliDelegationEntry[] {
  const bySession = useAtomValue(cliDelegationsBySessionAtom);
  const key = candidates.filter(Boolean).join("|");
  return useMemo(() => {
    for (const id of candidates) {
      if (id && bySession[id]?.length) return bySession[id]!;
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bySession, key]);
}

function fmtDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${m}分${sec.toString().padStart(2, "0")}秒`;
}

function fmtAge(updatedAt: number, now: number): string {
  const sec = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (sec < 2) return "刚刚";
  if (sec < 60) return `${sec}秒前`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}分前`;
  return `${Math.floor(m / 60)}时前`;
}

function StatusIcon({ status }: { status: SubagentStatus }) {
  if (status === "running" || status === "queued") {
    return <Loader2 className={`${s.statusIcon} ${s.spin}`} data-tone="run" size={14} aria-label="运行中" />;
  }
  if (status === "failed" || status === "interrupted") {
    return <AlertCircle className={s.statusIcon} data-tone="err" size={14} aria-label="失败" />;
  }
  return <CheckCircle2 className={s.statusIcon} data-tone="ok" size={14} aria-label="已完成" />;
}

function streamGlyph(entry: SubagentStreamEntry): ReactNode {
  if (entry.isError) return <AlertCircle className={s.streamGlyph} data-tone="err" size={11} aria-hidden />;
  if (entry.kind === "summary") {
    return <CheckCircle2 className={s.streamGlyph} data-tone="ok" size={11} aria-hidden />;
  }
  return <span className={s.streamDot} data-kind={entry.kind} aria-hidden />;
}

function StreamLine({ entry, active }: { entry: SubagentStreamEntry; active: boolean }) {
  return (
    <div className={s.streamLine} data-error={entry.isError ? "true" : undefined}>
      <span className={s.streamGlyphWrap}>{streamGlyph(entry)}</span>
      <span className={s.streamText} data-kind={entry.kind}>
        {entry.text}
        {active ? <Loader2 className={`${s.inlineSpin} ${s.spin}`} size={10} aria-hidden /> : null}
      </span>
    </div>
  );
}

function SubagentRow({ node, depth, now }: { node: SubagentNode; depth: number; now: number }) {
  const running = node.status === "running" || node.status === "queued";
  const [open, setOpen] = useState(() => running || depth < 2);

  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  const durationSeconds =
    typeof node.durationSeconds === "number"
      ? Math.max(0, Math.round(node.durationSeconds))
      : Math.max(0, Math.round((now - node.startedAt) / 1000));

  const tokens = (node.inputTokens ?? 0) + (node.outputTokens ?? 0);
  const subtitle = [
    node.model,
    fmtDuration(durationSeconds),
    node.toolCount ? `${node.toolCount} 工具` : "",
    tokens ? `${formatTokens(tokens)} tok` : "",
    `更新于 ${fmtAge(node.updatedAt, now)}`,
  ].filter(Boolean);

  const visibleRows = open ? node.stream.slice(-10) : node.stream.slice(-2);
  const fileLines = [...node.filesWritten.map((p) => `+ ${p}`), ...node.filesRead.map((p) => `· ${p}`)];

  return (
    <div className={s.row} style={depth > 0 ? { paddingLeft: 14 } : undefined} data-running={running ? "true" : undefined}>
      <button className={s.rowHead} type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRight className={s.chevron} data-open={open ? "true" : undefined} size={13} aria-hidden />
        <StatusIcon status={node.status} />
        <span className={s.rowMain}>
          <span className={s.goal} data-running={running ? "true" : undefined}>
            {node.goal}
          </span>
          {subtitle.length > 0 ? <span className={s.subtitle}>{subtitle.join(" · ")}</span> : null}
        </span>
        {running ? <span className={s.timer}>{fmtDuration(durationSeconds) || "0s"}</span> : null}
      </button>

      {visibleRows.length > 0 ? (
        <div className={s.stream}>
          {visibleRows.map((entry, i) => (
            <StreamLine
              key={`${entry.kind}:${entry.at}:${i}`}
              entry={entry}
              active={running && i === visibleRows.length - 1}
            />
          ))}
        </div>
      ) : null}

      {open && fileLines.length > 0 ? (
        <div className={s.files}>
          <span className={s.filesLabel}>文件</span>
          {fileLines.slice(0, 8).map((line) => (
            <span className={s.fileLine} key={line}>
              {line}
            </span>
          ))}
          {fileLines.length > 8 ? <span className={s.fileMore}>还有 {fileLines.length - 8} 个文件</span> : null}
        </div>
      ) : null}

      {node.children.length > 0 ? (
        <div className={s.children}>
          {node.children.map((child) => (
            <SubagentRow key={child.id} node={child} depth={depth + 1} now={now} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface RootGroup {
  id: string;
  delegationIndex: number;
  nodes: SubagentNode[];
  taskCount: number;
}

// Groups parallel workers (same taskCount, started close in time, distinct
// taskIndex) under one delegation header. Ported from upstream agents view.
function groupDelegations(roots: readonly SubagentNode[]): RootGroup[] {
  const groups: RootGroup[] = [];
  let n = 0;
  for (const node of roots) {
    const prev = groups.at(-1);
    const prevTail = prev?.nodes.at(-1);
    const closeInTime = prevTail ? Math.abs(node.startedAt - prevTail.startedAt) <= 5_000 : false;
    const sameShape = prev && node.taskCount > 1 && prev.taskCount === node.taskCount;
    const uniqueStep = prev ? !prev.nodes.some((item) => item.taskIndex === node.taskIndex) : false;

    if (prev && sameShape && closeInTime && uniqueStep) {
      prev.nodes.push(node);
      continue;
    }
    if (node.taskCount > 1) {
      n += 1;
      groups.push({ id: `delegation-${n}`, delegationIndex: n, nodes: [node], taskCount: node.taskCount });
      continue;
    }
    groups.push({ id: node.id, delegationIndex: 0, nodes: [node], taskCount: node.taskCount });
  }
  return groups;
}

// ── 外部 CLI 委派（Claude Code / Codex，P-047）────────────────────────────

const CLI_AGENT_LABELS: Record<CliDelegationEntry["agent"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

const CLI_MODE_LABELS: Record<string, string> = {
  print: "单次任务",
  exec: "执行任务",
  review: "代码评审",
  resume: "续写会话",
  interactive: "交互会话",
};

// 只给异常/特殊态配文字——completed/running 由状态图标表达，副标题不再
// 重复「已完成」字样（用户反馈：信息堆叠混乱）。
const CLI_ABNORMAL_STATUS_LABELS: Partial<Record<CliDelegationEntry["status"], string>> = {
  failed: "失败",
  killed: "已终止",
  lost: "状态丢失",
  detached: "结果未跟踪",
};

function CliStatusIcon({ status }: { status: CliDelegationEntry["status"] }) {
  if (status === "running") {
    return <Loader2 className={`${s.statusIcon} ${s.spin}`} data-tone="run" size={14} aria-label="执行中" />;
  }
  if (status === "failed" || status === "killed" || status === "lost") {
    return <AlertCircle className={s.statusIcon} data-tone="err" size={14} aria-label="失败" />;
  }
  if (status === "detached") {
    return <SquareTerminal className={s.statusIcon} size={14} aria-label="后台运行" />;
  }
  return <CheckCircle2 className={s.statusIcon} data-tone="ok" size={14} aria-label="已完成" />;
}

function cliStreamEntries(entry: CliDelegationEntry): SubagentStreamEntry[] {
  const out: SubagentStreamEntry[] = [];
  entry.timeline.forEach((event, index) => {
    let text = "";
    let kind: SubagentStreamEntry["kind"] = "progress";
    if (event.kind === "tool_use") {
      kind = "tool";
      const snippet = event.text ? `("${event.text.slice(0, 96)}")` : "";
      text = `${event.toolName ?? "工具"}${snippet}`;
    } else if (event.kind === "result") {
      kind = "summary";
      text = [
        event.isError ? "子任务出错" : "子任务完成",
        event.numTurns !== undefined ? `${event.numTurns} 轮` : "",
        event.outputTokens !== undefined ? `输出 ${formatTokens(event.outputTokens)} tok` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    } else if (event.kind === "init") {
      text = "已连接";
    } else {
      text = event.text ?? "";
    }
    if (text) out.push({ at: index, isError: event.isError, kind, text });
  });
  return out;
}

function CliDelegationRow({ entry, now }: { entry: CliDelegationEntry; now: number }) {
  const running = entry.status === "running";
  const [open, setOpen] = useState(running);

  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  const durationSeconds =
    typeof entry.durationS === "number"
      ? Math.max(0, Math.round(entry.durationS))
      : entry.startedAt > 0
        ? Math.max(0, Math.round((now - entry.startedAt) / 1000))
        : 0;

  // 一行只说必要的话：代理名 ·（后台）·（异常态说明）。completed/running
  // 由左侧图标表达；时长右置常显；会话 id 等细节收进展开态。
  const abnormal = CLI_ABNORMAL_STATUS_LABELS[entry.status];
  const subtitle = [
    CLI_AGENT_LABELS[entry.agent],
    entry.execution === "background" ? "后台" : "",
    abnormal ?? "",
  ].filter(Boolean);

  const stream = cliStreamEntries(entry);
  const visibleRows = open ? stream.slice(-10) : stream.slice(-2);
  const metaParts = open
    ? [
        entry.mode ? (CLI_MODE_LABELS[entry.mode] ?? "") : "",
        entry.result?.sessionId ? `会话 ${entry.result.sessionId}` : "",
        entry.result?.numTurns !== undefined ? `${entry.result.numTurns} 轮` : "",
        entry.workdir ? `目录 ${entry.workdir}` : "",
        entry.exitCode !== undefined && entry.exitCode !== null && entry.exitCode !== 0
          ? `退出码 ${entry.exitCode}`
          : "",
      ].filter(Boolean)
    : [];

  return (
    <div className={s.row} data-running={running ? "true" : undefined}>
      <button className={s.rowHead} type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRight className={s.chevron} data-open={open ? "true" : undefined} size={13} aria-hidden />
        <CliStatusIcon status={entry.status} />
        <span className={s.rowMain}>
          <span className={s.goal} data-running={running ? "true" : undefined}>
            {entry.promptExcerpt || CLI_AGENT_LABELS[entry.agent]}
          </span>
          {subtitle.length > 0 ? <span className={s.subtitle}>{subtitle.join(" · ")}</span> : null}
        </span>
        <span className={s.timer}>{fmtDuration(durationSeconds) || (running ? "0s" : "")}</span>
      </button>

      {visibleRows.length > 0 ? (
        <div className={s.stream}>
          {visibleRows.map((line, i) => (
            <StreamLine key={`${line.kind}:${line.at}:${i}`} entry={line} active={running && i === visibleRows.length - 1} />
          ))}
        </div>
      ) : null}

      {metaParts.length > 0 ? (
        <div className={s.files}>
          <span className={s.filesLabel}>详情</span>
          <span className={s.fileLine}>{metaParts.join(" · ")}</span>
        </div>
      ) : null}
    </div>
  );
}

function DelegationGroup({ group, now }: { group: RootGroup; now: number }) {
  if (group.nodes.length === 1 && group.taskCount <= 1) {
    return <SubagentRow node={group.nodes[0]!} depth={0} now={now} />;
  }
  const activeWorkers = group.nodes.filter((nd) => nd.status === "running" || nd.status === "queued").length;
  return (
    <section className={s.group}>
      <p className={s.groupLabel}>
        {group.delegationIndex > 0 ? `委派 #${group.delegationIndex} · ` : ""}
        {group.nodes.length} 个并行子Agent
        {activeWorkers > 0 ? <span className={s.groupActive}> · {activeWorkers} 个运行中</span> : null}
      </p>
      <div className={s.groupBody}>
        {group.nodes.map((node) => (
          <SubagentRow key={node.id} node={node} depth={0} now={now} />
        ))}
      </div>
    </section>
  );
}

export function SubagentPanel({
  subagents,
  cliDelegations = [],
  onClose,
  onClearFinished,
}: {
  subagents: SubagentProgress[];
  cliDelegations?: CliDelegationEntry[];
  onClose: () => void;
  onClearFinished?: () => void;
}) {
  const tree = useMemo(() => buildSubagentTree(subagents), [subagents]);
  const flat = useMemo(() => flattenSubagents(tree), [tree]);
  const groups = useMemo(() => groupDelegations(tree), [tree]);
  const active = activeSubagentCount(flat) + activeCliDelegationCount(cliDelegations);
  // 已结束的行（内部终态 + 外部非 running）保留在面板里供 debug，可手动清空。
  const finishedCount =
    flat.filter((nd) => nd.status !== "running" && nd.status !== "queued").length +
    cliDelegations.filter((entry) => entry.status !== "running").length;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (active <= 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [active]);

  const failed = flat.filter((nd) => nd.status === "failed" || nd.status === "interrupted").length;
  const tools = flat.reduce((sum, nd) => sum + (nd.toolCount ?? 0), 0);
  const files = flat.reduce((sum, nd) => sum + nd.filesRead.length + nd.filesWritten.length, 0);
  const tokens = flat.reduce((sum, nd) => sum + (nd.inputTokens ?? 0) + (nd.outputTokens ?? 0), 0);

  const summary = [
    `${flat.length} 个子Agent`,
    active > 0 ? `${active} 活跃` : "",
    failed > 0 ? `${failed} 失败` : "",
    tools > 0 ? `${tools} 工具` : "",
    files > 0 ? `${files} 文件` : "",
    tokens > 0 ? `${formatTokens(tokens)} tok` : "",
  ].filter(Boolean);

  const { width, onResizeStart } = usePanelWidth(360, 280, 640);

  return (
    <aside
      className={s.panel}
      aria-label="子Agent 监视"
      style={{ width, flexBasis: width }}
    >
      <PanelResizeHandle ariaLabel="调整子Agent 面板宽度" onPointerDown={onResizeStart} />
      <header className={s.header}>
        <span className={s.headerTitle}>
          <Bot size={14} aria-hidden />
          子Agent 监视
        </span>
        {onClearFinished && finishedCount > 0 ? (
          <button
            className={s.clearFinished}
            type="button"
            onClick={onClearFinished}
            title="移除已结束的子Agent 与委派记录"
          >
            清空已结束
          </button>
        ) : null}
        <button className={s.close} type="button" onClick={onClose} aria-label="关闭子Agent 监视">
          <X size={14} aria-hidden />
        </button>
      </header>

      {flat.length === 0 && cliDelegations.length === 0 ? (
        <div className={s.empty}>
          <Bot size={26} className={s.emptyIcon} aria-hidden />
          <p className={s.emptyTitle}>暂无子Agent 活动</p>
          <p className={s.emptyDesc}>
            当本会话派生子Agent（委派/并行任务）或调度 Claude Code / Codex 等外部编程Agent 时，
            这里会实时展示它们的层级、状态与流式输出。
          </p>
        </div>
      ) : (
        <>
          {flat.length > 0 ? <p className={s.summary}>{summary.join(" · ")}</p> : null}
          <div className={s.scroll}>
            {cliDelegations.length > 0 ? (
              <section className={s.group}>
                <p className={s.groupLabel}>
                  外部 CLI 委派 · {cliDelegations.length} 个
                  {activeCliDelegationCount(cliDelegations) > 0 ? (
                    <span className={s.groupActive}> · {activeCliDelegationCount(cliDelegations)} 个运行中</span>
                  ) : null}
                </p>
                <div className={s.groupBody}>
                  {cliDelegations.map((entry) => (
                    <CliDelegationRow key={entry.id} entry={entry} now={now} />
                  ))}
                </div>
              </section>
            ) : null}
            {groups.map((group) => (
              <DelegationGroup key={group.id} group={group} now={now} />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
