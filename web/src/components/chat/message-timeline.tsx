import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, WheelEvent } from "react";
import { useAtomValue } from "jotai";
import { AlertTriangle, ChevronRight, Info, Loader2, Volume2, VolumeX } from "lucide-react";
import { assistantAvatarDataUrlAtom, assistantDisplayNameAtom, showReasoningAtom } from "@/stores/ui";
import type { AssistantMessageStats, ChatMessage, ChatToolItem } from "./chat-types";
import { CliDelegationCard, entryFromChatTool } from "./cli-delegation-card";
import { cliDelegationsByToolIdAtom } from "@/stores/cli-delegations";
import { MessageImage } from "./message-image";
import { MessageSkeleton } from "./message-skeleton";
import { MessageText } from "./message-text";
import { CopyButton } from "@/components/ui/copy-button";
import s from "./message-timeline.module.css";
import { summarizeToolActivity } from "./tool-activity";
import { groupConsecutiveTools, groupElapsedMs } from "./group-tools";
import { truncateMiddle } from "@/lib/truncate-middle";
import { sanitizeTextForSpeech, speakText, voiceErrorMessage } from "@/lib/voice";
import {
  formatDurationMs,
  formatElapsedTimer,
  formatTokPerSec,
  formatTokens,
} from "@/lib/format";
import type { SessionUsageResult } from "@hermes/protocol";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const BOTTOM_FOLLOW_THRESHOLD_PX = 120;
const BOTTOM_REATTACH_THRESHOLD_PX = 8;

interface MessageTimelineProps {
  messages: ChatMessage[];
  loading?: boolean;
  statusMessage?: string;
  pendingApproval?: ReactNode;
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
  autoTts?: boolean;
}

interface TurnAnchor {
  id: string;
  index: number;
  title: string;
}

type SpeechPlaybackStatus = "idle" | "preparing" | "speaking";

interface SpeechPlaybackState {
  messageId: string | null;
  status: SpeechPlaybackStatus;
}

interface SpeechPlaybackError {
  message: string;
  messageId: string;
}

interface SpeechPlaybackControls {
  error: SpeechPlaybackError | null;
  onSpeak: (messageId: string, text: string) => void;
  onStop: () => void;
  state: SpeechPlaybackState;
}

export function resolveBottomFollowState(
  bottomDistance: number,
  userDetachedFromBottom: boolean,
): { nearBottom: boolean; userDetachedFromBottom: boolean } {
  const distance = Math.max(0, bottomDistance);
  if (userDetachedFromBottom) {
    const reattached = distance <= BOTTOM_REATTACH_THRESHOLD_PX;
    return {
      nearBottom: reattached,
      userDetachedFromBottom: !reattached,
    };
  }
  return {
    nearBottom: distance < BOTTOM_FOLLOW_THRESHOLD_PX,
    userDetachedFromBottom: false,
  };
}

function distanceFromBottom(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

// 只有"用户主动上滑"才应脱离贴底跟随。程序触发的轮次跳转平滑滚动同样会让 scrollTop
// 递减，但绝不能被当成用户手势——否则会把自己的跳转动画硬取消掉。
export function shouldDetachOnScroll(
  scrollTop: number,
  lastScrollTop: number,
  programmaticScroll: boolean,
): boolean {
  if (programmaticScroll) return false;
  return scrollTop < lastScrollTop - 1;
}

function formatDay(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (date.toDateString() === now.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function turnAnchorTitle(message: ChatMessage, index: number): string {
  const preview = getCopyableText(message)?.replace(/\s+/g, " ").trim();
  return preview
    ? `第 ${index + 1} 轮：${truncateMiddle(preview, 34)}`
    : `第 ${index + 1} 轮`;
}

const PROGRESS_TRANSLATIONS: Record<string, string> = {
  analyzing: "分析中",
  brainstorming: "头脑风暴中",
  cogitating: "沉思中",
  computing: "计算中",
  contemplating: "推理中",
  deliberating: "思考中",
  decrypting: "解密中",
  forging: "锻造中",
  formulating: "构思中",
  "hammering plans": "敲定方案中",
  "jacking in": "接入中",
  mulling: "琢磨中",
  musing: "遐想中",
  plotting: "谋划中",
  pondering: "斟酌中",
  processing: "处理中",
  reasoning: "推理中",
  reflecting: "反思中",
  ruminating: "深思中",
  synthesizing: "综合分析中",
  uploading: "上传中",
};

function localizeProgressLabel(text?: string): string {
  if (!text) return "思考中";
  const normalized = text.replace(/\s+/g, " ").trim();
  const base = normalized.replace(/\.{2,}|…/g, "").trim();
  if (!base) return "思考中";
  for (const [en, zh] of Object.entries(PROGRESS_TRANSLATIONS)) {
    if (base.toLowerCase().endsWith(en)) {
      return base.slice(0, base.length - en.length) + zh;
    }
  }
  return normalized;
}

const LONG_THINKING_THRESHOLD_S = 120;

interface ProgressBlockProps {
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
  progressText?: string;
}

function ProgressBlock({ turnStartedAt, sessionUsage, progressModel, progressText }: ProgressBlockProps) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!turnStartedAt) return;
    setElapsed(Date.now() - turnStartedAt);
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - turnStartedAt);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [turnStartedAt]);

  const label = localizeProgressLabel(progressText);
  const elapsedSeconds = Math.floor(elapsed / 1000);
  const showLongHint = elapsedSeconds >= LONG_THINKING_THRESHOLD_S;

  const tokenValue =
    typeof sessionUsage?.context_used === "number" &&
    Number.isFinite(sessionUsage.context_used) &&
    sessionUsage.context_used > 0
      ? sessionUsage.context_used
      : undefined;
  const model = progressModel || sessionUsage?.model;

  return (
    <div className={s.progressBlock} role="status" aria-live="polite">
      <span className={s.thinkingDot} />
      <span className={s.thinkingLabel}>
        {label}{showLongHint ? "（耗时较长）" : ""}
      </span>
      {(tokenValue || model) ? (
        <span className={s.thinkingMeta}>
          {tokenValue ? <span>{formatTokens(tokenValue)} tokens</span> : null}
          {tokenValue && model ? <span className={s.thinkingSep}>·</span> : null}
          {model ? <span className={s.thinkingModel}>{truncateMiddle(model, 24)}</span> : null}
        </span>
      ) : null}
      <span className={s.thinkingTimer}>{formatElapsedTimer(elapsed)}</span>
    </div>
  );
}

function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={s.reasoning}>
      <button
        type="button"
        className={s.disclosure}
        onClick={() => setOpen((value) => !value)}
        data-open={open}
      >
        <span className={s.chevron}>›</span>
        <span>{streaming ? "正在思考" : "推理过程"}</span>
      </button>
      {open ? <pre className={s.reasoningBody}>{text}</pre> : null}
    </div>
  );
}

function MoaReferenceBlock({
  label,
  text,
  index,
  count,
}: {
  label: string;
  text: string;
  index?: number;
  count?: number;
}) {
  const [open, setOpen] = useState(false);
  const position = index !== undefined && count !== undefined ? `（${index + 1}/${count}）` : "";

  return (
    <div className={s.reasoning}>
      <button
        type="button"
        className={s.disclosure}
        onClick={() => setOpen((value) => !value)}
        data-open={open}
      >
        <span className={s.chevron}>›</span>
        <span>{`参考模型 ${label}${position}`}</span>
      </button>
      {open ? <pre className={s.reasoningBody}>{text}</pre> : null}
    </div>
  );
}

function formatToolElapsed(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 100) return "<0.1s";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function ToolCard({ tool }: { tool: ChatToolItem }) {
  const [open, setOpen] = useState(tool.status === "error");
  const [elapsed, setElapsed] = useState(() =>
    tool.status === "running" ? Math.max(0, Date.now() - tool.startedAt) : 0,
  );

  useEffect(() => {
    if (tool.status === "error") setOpen(true);
  }, [tool.status]);

  useEffect(() => {
    if (tool.status !== "running") return;
    setElapsed(Math.max(0, Date.now() - tool.startedAt));
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - tool.startedAt);
    }, 500);
    return () => window.clearInterval(timer);
  }, [tool.startedAt, tool.status]);

  const elapsedLabel = formatToolElapsed(
    tool.status === "running"
      ? elapsed
      : tool.completedAt
        ? Math.max(0, tool.completedAt - tool.startedAt)
        : undefined,
  );
  const body = tool.error ?? tool.summary ?? tool.preview;
  const hasImages = Boolean(tool.images?.length);
  const hasBody = Boolean(body || tool.arguments || hasImages);

  return (
    <div className={s.toolCard} data-status={tool.status}>
      <button
        type="button"
        className={s.toolHeader}
        onClick={() => setOpen((value) => !value)}
        disabled={!hasBody}
        data-open={open}
      >
        <span className={s.toolStatus} data-status={tool.status} />
        <span className={s.toolName}>{tool.name}</span>
        {tool.context ? (
          <span className={s.toolContext} title={tool.context}>
            {truncateMiddle(tool.context)}
          </span>
        ) : null}
        {elapsedLabel ? <span className={s.toolElapsed}>{elapsedLabel}</span> : null}
      </button>
      {open && hasBody ? (
        <div className={s.toolBody}>
          {hasImages ? (
            <div className={s.toolImages}>
              {tool.images!.map((image, index) => (
                <MessageImage
                  key={`${image.url ?? image.name ?? image.alt ?? "image"}-${index}`}
                  image={image}
                />
              ))}
            </div>
          ) : null}
          {tool.arguments ? (
            <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
          ) : null}
          {body ? <pre data-error={tool.status === "error"}>{body}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolGroupCard({ tools }: { tools: ChatToolItem[] }) {
  const [open, setOpen] = useState(false);
  const head = tools[0];
  const elapsedLabel = formatToolElapsed(groupElapsedMs(tools));

  return (
    <div className={s.toolCard} data-status="done">
      <button
        type="button"
        className={s.toolHeader}
        onClick={() => setOpen((value) => !value)}
        data-open={open}
      >
        <span className={s.toolStatus} data-status="done" />
        <span className={s.toolName}>{head.name}</span>
        {head.context ? (
          <span className={s.toolContext} title={head.context}>
            {truncateMiddle(head.context)}
          </span>
        ) : null}
        <span className={s.toolBadge}>×{tools.length}</span>
        {elapsedLabel ? <span className={s.toolElapsed}>{elapsedLabel}</span> : null}
      </button>
      {open ? (
        <div className={s.toolGroupBody}>
          {tools.map((tool, index) => (
            <ToolCard key={`${tool.tool_id}-${index}`} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolActivity({ tools }: { tools: ChatToolItem[] }) {
  const hasError = tools.some((tool) => tool.status === "error");
  const hasRunning = tools.some((tool) => tool.status === "running");
  const [open, setOpen] = useState(hasError);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (hasError) setOpen(true);
  }, [hasError]);

  useEffect(() => {
    if (!hasRunning) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  const summary = useMemo(() => summarizeToolActivity(tools, now), [now, tools]);
  const elapsedLabel = formatToolElapsed(summary.elapsedMs);

  return (
    <div className={s.toolActivity} data-status={summary.status}>
      <button
        type="button"
        className={s.toolActivitySummary}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        data-open={open}
      >
        <ChevronRight
          className={s.toolActivityChevron}
          size={14}
          strokeWidth={2.25}
          aria-hidden="true"
        />
        <span className={s.toolStatus} data-status={summary.status} />
        <span className={s.toolActivityLabel}>{summary.label}</span>
        {summary.meta ? <span className={s.toolActivityMeta}>{summary.meta}</span> : null}
        {elapsedLabel ? <span className={s.toolElapsed}>{elapsedLabel}</span> : null}
      </button>
      {summary.error && !open ? (
        <div className={s.toolActivityError}>{summary.error}</div>
      ) : null}
      {open ? (
        <div className={s.toolActivityDetails}>
          {groupConsecutiveTools(tools).map((entry, index) =>
            entry.kind === "group" ? (
              <ToolGroupCard key={entry.key} tools={entry.tools} />
            ) : (
              <ToolCard key={`${entry.tool.tool_id}-${index}`} tool={entry.tool} />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function ToolChain({ tools }: { tools: ChatToolItem[] }) {
  if (tools.length === 0) return null;
  return (
    <div className={s.toolChain}>
      <ToolActivity tools={tools} />
    </div>
  );
}

interface MessageBlocksProps {
  message: ChatMessage;
  streaming: boolean;
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
}

function MessageBlocks({ message, streaming, turnStartedAt, sessionUsage, progressModel }: MessageBlocksProps) {
  const showReasoning = useAtomValue(showReasoningAtom);
  const cliDelegations = useAtomValue(cliDelegationsByToolIdAtom);
  const blocks = message.blocks ?? [];
  const items: ReactNode[] = [];
  let pendingTools: ChatToolItem[] = [];

  const flushTools = (key: string) => {
    if (pendingTools.length === 0) return;
    items.push(<ToolChain key={key} tools={pendingTools} />);
    pendingTools = [];
  };

  blocks.forEach((block, index) => {
    if (block.type === "tool") {
      // CLI 委派（Claude Code / Codex）升级为品牌化卡片：live store 命中
      // 优先（P-047 事件或旧内核回退），历史重载走渲染时按需重建。委派卡
      // 不进 ToolChain 聚合——它是多 Agent 协作的一等公民，不该被折叠进
      // "运行了 N 个工具"。
      const delegation = cliDelegations.get(block.tool.tool_id) ?? entryFromChatTool(block.tool);
      if (delegation) {
        flushTools(`tools-${index}`);
        items.push(<CliDelegationCard key={`cli-delegation-${index}`} entry={delegation} />);
        return;
      }
      pendingTools.push(block.tool);
      return;
    }

    flushTools(`tools-${index}`);

    if (block.type === "progress") {
      return;
    }

    if (block.type === "text") {
      items.push(
        <div key={`text-${index}`} className={s.turnText}>
          <MessageText text={block.text} streaming={streaming && index === blocks.length - 1} />
        </div>,
      );
      return;
    }

    if (block.type === "image") {
      items.push(
        <div key={`image-${index}`} className={s.imageBlock}>
          <MessageImage image={block.image} />
        </div>,
      );
      return;
    }

    if (block.type === "moa_reference") {
      // MoA 参考模型输出块——不受 showReasoning 门控：它是委员会成员的
      // 实际回答（MoA 的核心卖点），不是模型的内心独白；默认折叠不扰。
      items.push(
        <MoaReferenceBlock
          key={`moa-ref-${index}`}
          label={block.label}
          text={block.text}
          index={block.index}
          count={block.count}
        />,
      );
      return;
    }

    if (!showReasoning) return;

    items.push(
      <ReasoningBlock
        key={`reasoning-${index}`}
        text={block.text}
        streaming={streaming && index === blocks.length - 1}
      />,
    );
  });

  flushTools("tools-last");

  if (streaming) {
    const progressPart = blocks?.find((b) => b.type === "progress");
    items.push(
      <ProgressBlock
        key="tail-progress"
        turnStartedAt={turnStartedAt}
        sessionUsage={sessionUsage}
        progressModel={progressModel}
        progressText={progressPart?.type === "progress" ? progressPart.text : undefined}
      />,
    );
  }

  return <>{items}</>;
}

function getCopyableText(message: ChatMessage): string | undefined {
  if (message.blocks?.length) {
    const text = message.blocks
      .filter((block) => block.type === "text" || block.type === "reasoning")
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    return text || undefined;
  }
  return message.text || message.reasoning;
}

function getReadableText(message: ChatMessage): string | undefined {
  if (message.blocks?.length) {
    const text = message.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    return text || undefined;
  }
  return message.text?.trim() || undefined;
}

const FINISH_REASON_LABEL: Record<string, string> = {
  stop: "正常",
  end_turn: "正常",
  length: "上下文截断",
  tool_use: "调用工具",
  tool_calls: "调用工具",
  error: "错误",
  interrupted: "中断",
  content_filter: "内容过滤",
};

function finishReasonRisk(reason: string | undefined): "warn" | "err" | undefined {
  if (!reason) return undefined;
  if (reason === "length" || reason === "content_filter") return "warn";
  if (reason === "error") return "err";
  return undefined;
}

function sessionUsageFallbackStats(
  message: ChatMessage,
  sessionUsage: SessionUsageResult | null | undefined,
): AssistantMessageStats | undefined {
  if (message.role !== "assistant" || message.status === "streaming" || message.status === "error") return undefined;
  if (!sessionUsage) return undefined;

  const stats: AssistantMessageStats = {};
  const tokensInput = sessionUsage.input ?? sessionUsage.prompt;
  const tokensOutput = sessionUsage.output ?? sessionUsage.completion;
  const tokensTotal = sessionUsage.total ?? (
    typeof tokensInput === "number" || typeof tokensOutput === "number"
      ? (tokensInput ?? 0) + (tokensOutput ?? 0)
      : undefined
  );

  if (typeof tokensInput === "number") stats.tokensInput = tokensInput;
  if (typeof tokensOutput === "number") stats.tokensOutput = tokensOutput;
  if (typeof tokensTotal === "number") stats.tokensTotal = tokensTotal;
  if (typeof sessionUsage.cache_read === "number") stats.cacheRead = sessionUsage.cache_read;
  if (typeof sessionUsage.cache_write === "number") stats.cacheWrite = sessionUsage.cache_write;
  if (typeof sessionUsage.calls === "number") stats.apiCalls = sessionUsage.calls;
  if (typeof sessionUsage.model === "string" && sessionUsage.model) stats.model = sessionUsage.model;

  const costStatus = typeof sessionUsage.cost_status === "string"
    ? sessionUsage.cost_status.toLowerCase()
    : undefined;
  if (
    typeof sessionUsage.cost_usd === "number" &&
    Number.isFinite(sessionUsage.cost_usd) &&
    costStatus !== "stale_pricing" &&
    costStatus !== "unknown"
  ) {
    stats.costUsd = sessionUsage.cost_usd;
  }

  return Object.keys(stats).length > 0 ? stats : undefined;
}

function MessageStatsFooter({ stats }: { stats: AssistantMessageStats }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const inlineParts: string[] = [];
  if (stats.ttftMs !== undefined) inlineParts.push(`TTFT ${formatDurationMs(stats.ttftMs)}`);
  if (stats.durationMs !== undefined) inlineParts.push(formatDurationMs(stats.durationMs));
  if (stats.tokensTotal !== undefined) inlineParts.push(formatTokens(stats.tokensTotal));
  if (stats.tokPerSec !== undefined) inlineParts.push(`${formatTokPerSec(stats.tokPerSec)} tok/s`);

  if (inlineParts.length === 0) return null;

  const risk = finishReasonRisk(stats.finishReason);

  return (
    <span ref={wrapRef} className={s.messageStats} data-risk={risk}>
      <span className={s.messageStatsInline}>
        {inlineParts.map((part, idx) => (
          <span key={idx}>{part}</span>
        ))}
      </span>
      <button
        type="button"
        className={s.messageStatsToggle}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="查看详细统计"
        title="详细统计"
      >
        <Info size={12} strokeWidth={2} aria-hidden="true" />
      </button>
      {open ? (
        <div className={s.messageStatsPopover} role="dialog">
          <dl>
            {stats.model ? (
              <>
                <dt>模型</dt>
                <dd className={s.messageStatsModel}>{stats.model}</dd>
              </>
            ) : null}
            {stats.tokensInput !== undefined ? (
              <>
                <dt>输入</dt>
                <dd>{formatTokens(stats.tokensInput)}</dd>
              </>
            ) : null}
            {stats.tokensOutput !== undefined ? (
              <>
                <dt>输出</dt>
                <dd>{formatTokens(stats.tokensOutput)}</dd>
              </>
            ) : null}
            {stats.cacheRead !== undefined || stats.cacheWrite !== undefined ? (
              <>
                <dt>缓存</dt>
                <dd>
                  {formatTokens(stats.cacheRead)} 读 / {formatTokens(stats.cacheWrite)} 写
                </dd>
              </>
            ) : null}
            {stats.apiCalls !== undefined ? (
              <>
                <dt>API</dt>
                <dd>{stats.apiCalls} 次调用</dd>
              </>
            ) : null}
            {stats.finishReason ? (
              <>
                <dt>结束</dt>
                <dd data-risk={risk}>
                  {FINISH_REASON_LABEL[stats.finishReason] ?? stats.finishReason}
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      ) : null}
    </span>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
  speech?: SpeechPlaybackControls;
}

function MessageBubble({ message, turnStartedAt, sessionUsage, progressModel, speech }: MessageBubbleProps) {
  const showReasoning = useAtomValue(showReasoningAtom);
  const assistantDisplayName = useAtomValue(assistantDisplayNameAtom);
  const assistantAvatarDataUrl = useAtomValue(assistantAvatarDataUrlAtom);
  const isUser = message.role === "user";
  const isToolOnly = message.role === "tool";
  const isSystem = message.role === "system";
  const streaming = message.status === "streaming";
  const copyable = getCopyableText(message);
  const readable = !isUser && !isSystem && !isToolOnly && !streaming && message.status !== "error"
    ? getReadableText(message)
    : undefined;
  const speechStatus = speech?.state.messageId === message.id ? speech.state.status : "idle";
  const speechBusy = speechStatus === "preparing" || speechStatus === "speaking";
  const hasBlocks = !isUser && Boolean(message.blocks?.length);
  const messageStats = message.stats ?? sessionUsageFallbackStats(message, sessionUsage);

  if (isToolOnly) {
    return (
      <div className={s.messageRow} data-role="assistant">
        <div className={s.messageContent}>
          <ToolChain tools={message.tools ?? []} />
        </div>
      </div>
    );
  }

  if (isSystem) {
    const text = message.text || message.reasoning || "";
    return (
      <div className={s.messageRow} data-role="system">
        <div
          className={s.systemNotice}
          data-error={message.error ? "true" : undefined}
          role={message.error ? "alert" : "status"}
        >
          <AlertTriangle
            className={s.systemNoticeIcon}
            size={15}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <div className={s.systemNoticeBody}>
            {message.error ? <div className={s.systemNoticeTitle}>请求失败</div> : null}
            <div className={s.systemNoticeText}>{text}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.messageRow} data-role={isUser ? "user" : "assistant"}>
      <div className={s.messageContent}>
        {!isUser ? (
          <div className={assistantAvatarDataUrl ? s.assistantIdentity : s.assistantName}>
            {assistantAvatarDataUrl ? (
              <img className={s.assistantAvatar} src={assistantAvatarDataUrl} alt={`${assistantDisplayName} 头像`} />
            ) : null}
            <span>{assistantDisplayName}</span>
          </div>
        ) : null}
        <div className={s.bubble} data-role={isUser ? "user" : "assistant"}>
          {hasBlocks ? (
            <MessageBlocks
              message={message}
              streaming={streaming}
              turnStartedAt={turnStartedAt}
              sessionUsage={sessionUsage}
              progressModel={progressModel}
            />
          ) : (
            <>
              {message.text ? <MessageText text={message.text} streaming={streaming} /> : null}
              {message.images?.length ? (
                <div className={s.messageImages}>
                  {message.images.map((image, index) => (
                    <MessageImage
                      key={`${image.url ?? image.name ?? image.alt ?? "image"}-${index}`}
                      image={image}
                    />
                  ))}
                </div>
              ) : null}
              {showReasoning && message.reasoning ? (
                <ReasoningBlock text={message.reasoning} streaming={streaming && !message.text} />
              ) : null}
              {message.tools?.length ? <ToolChain tools={message.tools} /> : null}
              {streaming ? <ProgressBlock progressModel={progressModel} /> : null}
            </>
          )}
        </div>
        <div className={s.messageActions}>
          <span className={s.messageActionsControls}>
            <span>{formatTime(message.createdAt)}</span>
            {copyable ? (
              <CopyButton text={copyable} showStatusIcon={false}>
                复制
              </CopyButton>
            ) : null}
            {readable && speech ? (
              <button
                type="button"
                onClick={() => {
                  if (speechBusy) {
                    speech.onStop();
                  } else {
                    speech.onSpeak(message.id, readable);
                  }
                }}
                data-speech-state={speechStatus}
                aria-pressed={speechBusy}
                title={speechBusy ? "停止朗读" : "朗读回复"}
              >
                {speechStatus === "preparing" ? (
                  <Loader2 aria-hidden="true" />
                ) : speechStatus === "speaking" ? (
                  <VolumeX aria-hidden="true" />
                ) : (
                  <Volume2 aria-hidden="true" />
                )}
                <span>{speechBusy ? "停止" : "朗读"}</span>
              </button>
            ) : null}
            {speech?.error?.messageId === message.id ? (
              <span className={s.messageSpeechError}>{speech.error.message}</span>
            ) : null}
          </span>
          {messageStats ? <MessageStatsFooter stats={messageStats} /> : null}
        </div>
      </div>
    </div>
  );
}

export function MessageTimeline({
  messages,
  loading = false,
  statusMessage,
  pendingApproval,
  turnStartedAt,
  sessionUsage,
  progressModel,
  autoTts = false,
}: MessageTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const turnAnchorRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const nearBottomRef = useRef(true);
  const userDetachedFromBottomRef = useRef(false);
  const autoAnchorRef = useRef(false);
  const autoAnchorTimerRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  // 程序触发的轮次跳转（平滑滚动）守卫：跳转动画期间 onScroll 会被误判为用户上滑而
  // 触发 detachFromBottomAutoFollow 硬取消滚动，这里用标记把跳转滚动与用户手势区分开。
  const programmaticScrollRef = useRef(false);
  const programmaticTargetRef = useRef(0);
  const programmaticTimerRef = useRef<number | null>(null);
  const messageCountRef = useRef(0);
  const firstMessageIdRef = useRef<string | undefined>(undefined);
  const speechAudioRef = useRef<HTMLAudioElement | null>(null);
  const speechStopRef = useRef<(() => void) | null>(null);
  const speechSequenceRef = useRef(0);
  const autoTtsSeenRef = useRef<Set<string>>(new Set());
  const autoTtsSessionKeyRef = useRef<string | undefined>(undefined);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [speechState, setSpeechState] = useState<SpeechPlaybackState>({
    messageId: null,
    status: "idle",
  });
  const [speechError, setSpeechError] = useState<SpeechPlaybackError | null>(null);
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.text ||
          message.reasoning ||
          message.images?.length ||
          message.tools?.length ||
          message.blocks?.length,
      ),
    [messages],
  );
  const turnAnchors = useMemo<TurnAnchor[]>(() => {
    const anchors: TurnAnchor[] = [];
    for (const message of visibleMessages) {
      if (message.role !== "user") continue;
      const index = anchors.length;
      anchors.push({
        id: message.id,
        index,
        title: turnAnchorTitle(message, index),
      });
    }
    return anchors;
  }, [visibleMessages]);
  const showTurnRail = turnAnchors.length > 1;

  const stopSpeech = useCallback(() => {
    speechSequenceRef.current += 1;
    speechStopRef.current?.();
    speechStopRef.current = null;
    if (speechAudioRef.current) {
      speechAudioRef.current.pause();
      speechAudioRef.current.src = "";
      speechAudioRef.current.load();
      speechAudioRef.current = null;
    }
    setSpeechState({ messageId: null, status: "idle" });
  }, []);

  const playSpeech = useCallback(async (messageId: string, text: string) => {
    const speakableText = sanitizeTextForSpeech(text);
    if (!speakableText) {
      setSpeechError({ messageId, message: "没有可朗读的文本。" });
      return;
    }

    stopSpeech();
    const ownSequence = speechSequenceRef.current;
    setSpeechError(null);
    setSpeechState({ messageId, status: "preparing" });

    try {
      const response = await speakText(speakableText);
      if (speechSequenceRef.current !== ownSequence) return;

      const audio = new Audio(response.data_url);
      speechAudioRef.current = audio;
      setSpeechState({ messageId, status: "speaking" });

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          audio.removeEventListener("ended", onEnded);
          audio.removeEventListener("error", onError);
          if (speechStopRef.current === onStop) speechStopRef.current = null;
        };
        const onEnded = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error("音频播放失败"));
        };
        const onStop = () => {
          cleanup();
          resolve();
        };
        speechStopRef.current = onStop;
        audio.addEventListener("ended", onEnded, { once: true });
        audio.addEventListener("error", onError, { once: true });
        void audio.play().catch(reject);
      });

      if (speechSequenceRef.current !== ownSequence) return;
      speechAudioRef.current = null;
      setSpeechState({ messageId: null, status: "idle" });
    } catch (error) {
      if (speechSequenceRef.current !== ownSequence) return;
      speechAudioRef.current = null;
      speechStopRef.current = null;
      setSpeechState({ messageId: null, status: "idle" });
      setSpeechError({ messageId, message: voiceErrorMessage(error, "朗读失败") });
    }
  }, [stopSpeech]);

  useEffect(() => () => {
    speechSequenceRef.current += 1;
    speechStopRef.current?.();
    speechStopRef.current = null;
    if (speechAudioRef.current) {
      speechAudioRef.current.pause();
      speechAudioRef.current.src = "";
      speechAudioRef.current.load();
      speechAudioRef.current = null;
    }
  }, []);

  useEffect(() => {
    const completed = messages.filter((message) =>
      message.role === "assistant" &&
      message.status === "complete" &&
      Boolean(getReadableText(message)),
    );
    const sessionKey = messages[0]?.id;
    if (autoTtsSessionKeyRef.current !== sessionKey) {
      autoTtsSessionKeyRef.current = sessionKey;
      autoTtsSeenRef.current = new Set(completed.map((message) => message.id));
      return;
    }

    const fresh = completed.filter((message) => !autoTtsSeenRef.current.has(message.id));
    for (const message of completed) autoTtsSeenRef.current.add(message.id);
    if (!autoTts || fresh.length === 0) return;

    const target = fresh[fresh.length - 1];
    const text = target ? getReadableText(target) : undefined;
    if (target && text) void playSpeech(target.id, text);
  }, [autoTts, messages, playSpeech]);

  const speechControls = useMemo<SpeechPlaybackControls>(() => ({
    error: speechError,
    onSpeak: (messageId, text) => void playSpeech(messageId, text),
    onStop: stopSpeech,
    state: speechState,
  }), [playSpeech, speechError, speechState, stopSpeech]);

  const setTurnAnchorNode = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) {
      turnAnchorRefs.current.set(id, node);
    } else {
      turnAnchorRefs.current.delete(id);
    }
  }, []);

  const updateActiveTurnFromScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || turnAnchors.length < 2) return;

    const containerRect = container.getBoundingClientRect();
    const thresholdY = containerRect.top + Math.min(container.clientHeight * 0.35, 180);
    let currentId = turnAnchors[0]?.id ?? null;

    for (const turn of turnAnchors) {
      const node = turnAnchorRefs.current.get(turn.id);
      if (!node) continue;
      if (node.getBoundingClientRect().top <= thresholdY) {
        currentId = turn.id;
      } else {
        break;
      }
    }

    if (currentId) {
      setActiveTurnId((previous) => previous === currentId ? previous : currentId);
    }
  }, [turnAnchors]);

  const scrollToTurn = useCallback((id: string) => {
    const container = containerRef.current;
    const node = turnAnchorRefs.current.get(id);
    if (!container || !node) return;

    if (autoAnchorTimerRef.current !== null) {
      window.clearTimeout(autoAnchorTimerRef.current);
      autoAnchorTimerRef.current = null;
    }
    autoAnchorRef.current = false;

    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const top = container.scrollTop + nodeRect.top - containerRect.top - 12;
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.min(Math.max(0, top), maxTop);
    nearBottomRef.current = container.scrollHeight - targetTop - container.clientHeight < BOTTOM_FOLLOW_THRESHOLD_PX;
    userDetachedFromBottomRef.current = !nearBottomRef.current;
    // 标记这是一次程序跳转：handleScroll 在到达目标前不得把它当成用户上滑。
    // 兜底定时器防止动画因目标 clamp / 内容重排始终差几像素而无法清除标记。
    programmaticScrollRef.current = true;
    programmaticTargetRef.current = targetTop;
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
    }
    programmaticTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticTimerRef.current = null;
    }, 700);
    container.scrollTo({ top: targetTop, behavior: "smooth" });
    lastScrollTopRef.current = container.scrollTop;
    setActiveTurnId(id);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const container = containerRef.current;
    if (!container) return;
    if (userDetachedFromBottomRef.current) return;
    userDetachedFromBottomRef.current = false;
    container.scrollTo({
      top: container.scrollHeight,
      behavior,
    });
    if (behavior === "auto") {
      lastScrollTopRef.current = container.scrollTop;
    }
  }, []);

  const clearAutoAnchor = useCallback(() => {
    if (autoAnchorTimerRef.current !== null) {
      window.clearTimeout(autoAnchorTimerRef.current);
      autoAnchorTimerRef.current = null;
    }
    autoAnchorRef.current = false;
  }, []);

  const detachFromBottomAutoFollow = useCallback(() => {
    const container = containerRef.current;
    // 用户的显式手势（滚轮/拖动）应能中断进行中的轮次跳转并夺回滚动控制。
    programmaticScrollRef.current = false;
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
      programmaticTimerRef.current = null;
    }
    clearAutoAnchor();
    userDetachedFromBottomRef.current = true;
    nearBottomRef.current = false;
    if (container) {
      // Cancel any in-flight smooth/initial auto scroll so an explicit user
      // upward gesture cannot be pulled back to the bottom by a later layout
      // settle, ResizeObserver tick, or timeout from the initial history render.
      container.scrollTo({ top: container.scrollTop, behavior: "auto" });
      lastScrollTopRef.current = container.scrollTop;
    }
  }, [clearAutoAnchor]);

  useEffect(() => {
    const knownIds = new Set(turnAnchors.map((turn) => turn.id));
    for (const id of Array.from(turnAnchorRefs.current.keys())) {
      if (!knownIds.has(id)) turnAnchorRefs.current.delete(id);
    }
  }, [turnAnchors]);

  useEffect(() => {
    if (turnAnchors.length < 2) {
      setActiveTurnId((previous) => previous === null ? previous : null);
      return;
    }

    const hasActive = activeTurnId != null && turnAnchors.some((turn) => turn.id === activeTurnId);
    if (hasActive && !nearBottomRef.current) return;

    const lastId = turnAnchors[turnAnchors.length - 1]?.id ?? null;
    setActiveTurnId((previous) => previous === lastId ? previous : lastId);
  }, [activeTurnId, turnAnchors]);

  useIsomorphicLayoutEffect(() => {
    const previousMessageCount = messageCountRef.current;
    const previousFirstMessageId = firstMessageIdRef.current;
    const nextFirstMessageId = visibleMessages[0]?.id;
    const sessionChanged =
      previousFirstMessageId !== undefined &&
      nextFirstMessageId !== undefined &&
      previousFirstMessageId !== nextFirstMessageId;

    messageCountRef.current = visibleMessages.length;
    firstMessageIdRef.current = nextFirstMessageId;

    if (visibleMessages.length === 0) {
      nearBottomRef.current = true;
      userDetachedFromBottomRef.current = false;
      lastScrollTopRef.current = 0;
      return;
    }

    if (sessionChanged) {
      nearBottomRef.current = true;
      userDetachedFromBottomRef.current = false;
      lastScrollTopRef.current = 0;
    }

    const container = containerRef.current;
    if (!container || !nearBottomRef.current) return;
    const initialHistoryRender = previousMessageCount === 0 || sessionChanged;
    // Bottom-follow must move synchronously. A smooth scroll targets the current
    // scrollHeight, but streaming can grow the message again before the animation
    // arrives; the intermediate scroll event then looks far from the bottom and
    // disables its own ResizeObserver follow-up even though the user never scrolled.
    scrollToBottom("auto");

    // 长会话里 Markdown、表格、代码块等内容会在本次提交后继续改变实际高度。
    // 初次进入历史会话时不要依赖一次平滑滚动，否则 WebKit/Tauri 里可能先滚到
    // 一个尚未稳定的中间位置，用户看到空白，手动滚动后才触发重绘。
    if (initialHistoryRender) {
      clearAutoAnchor();
      autoAnchorRef.current = true;
      window.requestAnimationFrame(() => {
        scrollToBottom("auto");
        window.requestAnimationFrame(() => scrollToBottom("auto"));
      });
      autoAnchorTimerRef.current = window.setTimeout(() => {
        if (userDetachedFromBottomRef.current) {
          autoAnchorRef.current = false;
          autoAnchorTimerRef.current = null;
          return;
        }
        scrollToBottom("auto");
        nearBottomRef.current = true;
        userDetachedFromBottomRef.current = false;
        autoAnchorRef.current = false;
        autoAnchorTimerRef.current = null;
      }, 650);
    }
  }, [clearAutoAnchor, pendingApproval, scrollToBottom, statusMessage, visibleMessages]);

  useEffect(() => {
    const container = containerRef.current;
    const messagesElement = messagesRef.current;
    if (!container || !messagesElement || typeof ResizeObserver === "undefined") return;

    let frame = 0;
    const anchorToBottom = () => {
      if (userDetachedFromBottomRef.current) return;
      if (!nearBottomRef.current && !autoAnchorRef.current) return;
      container.scrollTop = container.scrollHeight;
      lastScrollTopRef.current = container.scrollTop;
    };
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(anchorToBottom);
    });
    observer.observe(messagesElement);
    // composer 增高（多行输入 / 技能面板 / 附件托盘 / 上下文告警 / 队列面板等）会让滚动视口
    // 从底部变矮，但 .messages 内容高度不变、上面这个 observer 不会触发，导致最新内容被挤到
    // 视口下沿之外（看起来"藏在输入框后面"）。一并观察滚动容器自身：视口高度变化时也走
    // anchorToBottom 重新贴底——其守卫（userDetached / nearBottom）保证不会把已上滑的用户拽回。
    observer.observe(container);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (autoAnchorTimerRef.current !== null) {
        window.clearTimeout(autoAnchorTimerRef.current);
      }
      if (programmaticTimerRef.current !== null) {
        window.clearTimeout(programmaticTimerRef.current);
      }
    };
  }, []);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      detachFromBottomAutoFollow();
    }
  };

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;

    // 轮次跳转动画进行中：不要把它当成用户上滑（否则会自取消）。到达目标后解除守卫。
    if (programmaticScrollRef.current) {
      lastScrollTopRef.current = container.scrollTop;
      if (Math.abs(container.scrollTop - programmaticTargetRef.current) <= 2) {
        programmaticScrollRef.current = false;
        if (programmaticTimerRef.current !== null) {
          window.clearTimeout(programmaticTimerRef.current);
          programmaticTimerRef.current = null;
        }
      }
      updateActiveTurnFromScroll();
      return;
    }

    const bottomDistance = distanceFromBottom(container);
    const scrollingUp = shouldDetachOnScroll(
      container.scrollTop,
      lastScrollTopRef.current,
      programmaticScrollRef.current,
    );

    if (scrollingUp) {
      detachFromBottomAutoFollow();
    } else if (autoAnchorRef.current && !userDetachedFromBottomRef.current) {
      nearBottomRef.current = true;
    } else {
      const next = resolveBottomFollowState(
        bottomDistance,
        userDetachedFromBottomRef.current,
      );
      nearBottomRef.current = next.nearBottom;
      userDetachedFromBottomRef.current = next.userDetachedFromBottom;
    }
    lastScrollTopRef.current = container.scrollTop;
    updateActiveTurnFromScroll();
  };

  return (
    <div
      ref={containerRef}
      className={s.scroll}
      onWheel={handleWheel}
      onScroll={handleScroll}
      role="log"
      aria-live="polite"
    >
      {showTurnRail ? (
        <div className={s.turnRailWrap}>
          <nav className={s.turnRail} aria-label="对话轮次定位">
            {turnAnchors.map((turn) => {
              const active = turn.id === activeTurnId;
              return (
                <button
                  key={turn.id}
                  type="button"
                  className={s.turnDot}
                  data-active={active ? "true" : undefined}
                  aria-current={active ? "step" : undefined}
                  aria-label={`定位到第 ${turn.index + 1} 轮对话`}
                  title={turn.title}
                  onClick={() => scrollToTurn(turn.id)}
                />
              );
            })}
          </nav>
        </div>
      ) : null}
      <div ref={messagesRef} className={s.messages}>
        {loading ? <MessageSkeleton /> : null}
        {!loading && visibleMessages.length === 0 && !statusMessage && !pendingApproval ? (
          <div className={s.empty}>
            <div className={s.emptyTitle}>暂无对话记录</div>
            <div className={s.emptySub}>发送一条消息开始继续这个任务。</div>
          </div>
        ) : null}

        {visibleMessages.map((message, index) => {
          const previous = visibleMessages[index - 1];
          const showDate = !previous || formatDay(previous.createdAt) !== formatDay(message.createdAt);
          const isLast = index === visibleMessages.length - 1;
          return (
            <div
              key={message.id}
              ref={message.role === "user" ? (node) => setTurnAnchorNode(message.id, node) : undefined}
              data-turn-anchor={message.role === "user" ? "true" : undefined}
            >
              {showDate ? <div className={s.dateSeparator}>{formatDay(message.createdAt)}</div> : null}
              <MessageBubble
                message={message}
                turnStartedAt={isLast ? turnStartedAt : undefined}
                sessionUsage={isLast ? sessionUsage : undefined}
                progressModel={isLast ? progressModel : undefined}
                speech={speechControls}
              />
            </div>
          );
        })}

        {statusMessage ? <div className={s.statusMessage}>{statusMessage}</div> : null}
        {pendingApproval}
      </div>
    </div>
  );
}
