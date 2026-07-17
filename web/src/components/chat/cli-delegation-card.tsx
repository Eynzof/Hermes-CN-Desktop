// CLI 委派卡片：聊天流里把识别出的 Claude Code / Codex 委派从普通 ToolCard
// 升级为品牌化展示——任务摘要、运行状态与计时、实时时间线（后台委派）、
// 结构化结果（session_id / 轮数 / 成本），并提供复制 session_id（--resume 用）
// 与复制完整命令的动作。数据来源见 stores/cli-delegations.ts。
import { useEffect, useState } from "react";

import { CopyButton } from "@/components/ui/copy-button";
import type { ChatToolItem } from "./chat-types";
import {
  entryFromHistoryToolPart,
  type CliDelegationEntry,
  type CliDelegationStatus,
} from "@/stores/cli-delegations";
import type { CliDelegationSubEvent } from "@/lib/cli-delegation";
import s from "./cli-delegation-card.module.css";

const AGENT_LABELS: Record<CliDelegationEntry["agent"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

const STATUS_LABELS: Record<CliDelegationStatus, string> = {
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  killed: "已终止",
  lost: "状态丢失",
  detached: "后台运行",
};

const MODE_LABELS: Record<string, string> = {
  print: "单次任务",
  exec: "执行任务",
  review: "代码评审",
  resume: "续写会话",
  interactive: "交互会话",
};

const STATUS_DOT: Record<CliDelegationStatus, "running" | "done" | "error" | "neutral"> = {
  running: "running",
  completed: "done",
  failed: "error",
  killed: "error",
  lost: "error",
  detached: "neutral",
};

// 渲染路径逐块调用，WeakMap 按工具对象缓存分类/解析结果（对象引用在无关
// 重渲染间稳定；store 更新会生成新对象自然失效）。
const chatToolEntryCache = new WeakMap<ChatToolItem, CliDelegationEntry | null>();

/** 从聊天工具项（历史重载或错过实时事件的场景）按需重建委派条目。
 *  live store 里没有对应条目时的渲染兜底；分类不命中返回 null。 */
export function entryFromChatTool(tool: ChatToolItem): CliDelegationEntry | null {
  if (chatToolEntryCache.has(tool)) return chatToolEntryCache.get(tool) ?? null;
  const entry = computeEntryFromChatTool(tool);
  chatToolEntryCache.set(tool, entry);
  return entry;
}

function computeEntryFromChatTool(tool: ChatToolItem): CliDelegationEntry | null {
  if (tool.name !== "terminal" || !tool.arguments) return null;
  let output: unknown = tool.summary;
  if (typeof tool.summary === "string" && tool.summary.trim().startsWith("{")) {
    try {
      output = JSON.parse(tool.summary);
    } catch {
      output = tool.summary;
    }
  }
  return entryFromHistoryToolPart({
    toolCallId: tool.tool_id,
    name: tool.name,
    state: tool.status,
    input: tool.arguments,
    output,
    startedAt: tool.startedAt,
    completedAt: tool.completedAt,
  });
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function useElapsedLabel(entry: CliDelegationEntry): string {
  const running = entry.status === "running";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [running]);

  if (running) {
    return entry.startedAt > 0 ? formatElapsed(now - entry.startedAt) : "";
  }
  if (entry.durationS !== undefined) return formatElapsed(entry.durationS * 1000);
  if (entry.completedAt && entry.startedAt > 0) {
    return formatElapsed(entry.completedAt - entry.startedAt);
  }
  return "";
}

function TimelineRow({ event }: { event: CliDelegationSubEvent }) {
  if (event.kind === "init") {
    const detail = [event.sessionId ? `会话 ${event.sessionId}` : "", event.model ?? ""]
      .filter(Boolean)
      .join(" · ");
    return (
      <li className={s.timelineRow} data-kind="init">
        <span className={s.timelineText}>{detail ? `已连接 · ${detail}` : "已连接"}</span>
      </li>
    );
  }
  if (event.kind === "tool_use") {
    return (
      <li className={s.timelineRow} data-kind="tool_use">
        <span className={s.timelineTool}>{event.toolName ?? "工具"}</span>
        {event.text ? <span className={s.timelineText}>{event.text}</span> : null}
      </li>
    );
  }
  if (event.kind === "result") {
    const parts = [
      event.numTurns !== undefined ? `${event.numTurns} 轮` : "",
      event.outputTokens !== undefined ? `输出 ${event.outputTokens} tokens` : "",
      event.text ?? "",
    ].filter(Boolean);
    return (
      <li className={s.timelineRow} data-kind="result" data-error={event.isError === true}>
        <span className={s.timelineText}>
          {event.isError ? "子任务出错" : "子任务完成"}
          {parts.length ? ` · ${parts.join(" · ")}` : ""}
        </span>
      </li>
    );
  }
  return (
    <li className={s.timelineRow} data-kind={event.kind} data-error={event.isError === true}>
      <span className={s.timelineText}>{event.text}</span>
    </li>
  );
}

export function CliDelegationCard({ entry }: { entry: CliDelegationEntry }) {
  const [open, setOpen] = useState(entry.status === "running");
  const [showRaw, setShowRaw] = useState(false);
  const elapsedLabel = useElapsedLabel(entry);

  useEffect(() => {
    if (entry.status === "failed") setOpen(true);
  }, [entry.status]);

  const modeLabel = entry.mode ? MODE_LABELS[entry.mode] : undefined;
  const sessionId = entry.result?.sessionId;
  const hasBody = Boolean(
    entry.promptExcerpt || entry.timeline.length || entry.outputTail || entry.result || entry.command,
  );

  // 计费信息不进 UI（CN 用户多走中转套餐，USD 成本无参考意义且添乱）。
  const resultParts = entry.result
    ? [
        sessionId ? `会话 ${sessionId}` : "",
        entry.result.numTurns !== undefined ? `${entry.result.numTurns} 轮` : "",
        entry.result.outputTokens !== undefined ? `输出 ${entry.result.outputTokens} tokens` : "",
      ].filter(Boolean)
    : [];

  return (
    <div className={s.card} data-agent={entry.agent} data-status={entry.status}>
      <button
        type="button"
        className={s.header}
        onClick={() => setOpen((value) => !value)}
        disabled={!hasBody}
        data-open={open}
      >
        <span className={s.brandDot} data-agent={entry.agent} data-dot={STATUS_DOT[entry.status]} />
        <span className={s.brandName}>{AGENT_LABELS[entry.agent]}</span>
        {modeLabel ? <span className={s.badge}>{modeLabel}</span> : null}
        {entry.execution === "background" ? <span className={s.badge}>后台</span> : null}
        <span className={s.statusText} data-status={entry.status}>
          {STATUS_LABELS[entry.status]}
          {entry.status === "detached" ? " · 结果未跟踪" : ""}
        </span>
        {elapsedLabel ? <span className={s.elapsed}>{elapsedLabel}</span> : null}
      </button>

      {entry.promptExcerpt ? (
        <div className={s.prompt} title={entry.promptExcerpt}>
          {entry.promptExcerpt}
        </div>
      ) : null}

      {open ? (
        <div className={s.body}>
          {entry.timeline.length ? (
            <ol className={s.timeline}>
              {entry.timeline.map((event, index) => (
                <TimelineRow key={`${event.kind}-${index}`} event={event} />
              ))}
            </ol>
          ) : null}

          {entry.status === "running" && !entry.timeline.length && entry.outputTail ? (
            <pre className={s.tail}>{entry.outputTail}</pre>
          ) : null}

          {resultParts.length ? <div className={s.resultRow}>{resultParts.join(" · ")}</div> : null}
          {entry.truncated ? <div className={s.truncatedNote}>输出过大，已截断为摘要模式</div> : null}
          {entry.exitCode !== undefined && entry.exitCode !== null && entry.exitCode !== 0 ? (
            <div className={s.errorNote}>退出码 {entry.exitCode}</div>
          ) : null}

          <div className={s.actions}>
            {sessionId ? (
              <CopyButton text={sessionId} className={s.actionButton}>
                复制会话 ID
              </CopyButton>
            ) : null}
            {entry.command ? (
              <CopyButton text={entry.command} className={s.actionButton}>
                复制命令
              </CopyButton>
            ) : null}
            {entry.outputTail && entry.status !== "running" ? (
              <button
                type="button"
                className={s.actionButton}
                onClick={() => setShowRaw((value) => !value)}
              >
                {showRaw ? "收起原始输出" : "查看原始输出"}
              </button>
            ) : null}
          </div>

          {showRaw && entry.outputTail ? <pre className={s.tail}>{entry.outputTail}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}
