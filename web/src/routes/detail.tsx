import { useEffect, useMemo, useCallback, useRef, useState, type CSSProperties } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Bot, Check, Copy, PanelRight } from "lucide-react";
import {
  activeSessionIdAtom,
  conversationFontSizeAtom,
  conversationFontSizeVars,
  conversationWidthMaxWidth,
  conversationWidthModeAtom,
  rightRailVisibleAtom,
} from "@/stores/ui";
import {
  appendNoticeAtom,
  recoverCompletedTurnFromStoredMessagesAtom,
  removeApprovalAtom,
} from "@/stores/chat";
import { useSession, useSessionMessages, useSessions } from "@/hooks/use-sessions";
import { useGateway } from "@/hooks/use-gateway";
import { useConfig, useModelInfo } from "@/hooks/use-config";
import { useModelOptions } from "@/hooks/use-model-options";
import { useComposerTimer } from "@/hooks/use-composer-timer";
import { useStallWatchdog } from "@/hooks/use-stall-watchdog";
import { useSessionResolution } from "@/hooks/use-session-resolution";
import { useSessionUsagePolling } from "@/hooks/use-session-usage-polling";
import { recordModelUsage } from "@/lib/model-usage-log";
import { readSessionModelOverride } from "@/lib/session-model-override";
import { prepareComposerPrompt } from "@/lib/composer-prompt";
import { parseBuiltinComposerCommand } from "@/lib/builtin-commands";
import { formatCompressNotice } from "@/lib/compress-feedback";
import { formatElapsedTimer } from "@/lib/format";
import { getGatewayClient } from "@/lib/gateway-client";
import { useSessionTurnStats } from "@/hooks/use-session-turn-stats";
import {
  buildComposerContextUsage,
  estimateRenderedContextTokens,
} from "@/lib/context-usage";
import { resolveModelContextWindow } from "@/lib/model-context";
import { reasoningEffortFromConfig, type ReasoningEffort } from "@/lib/reasoning-effort";
import { sessionDisplayTitle } from "@/lib/session-title";
import {
  readSessionTitleOverrides,
  subscribeSessionUiStateChanges,
} from "@/lib/session-ui-state";
import { uploadAttachmentFile } from "@/lib/transport";
import { voiceAutoTtsFromConfig } from "@/lib/voice";
import {
  rememberSessionWorkspace,
  rememberWorkspaceProject,
  resolveSessionWorkspace,
} from "@/lib/workspaces";
import { TopBar, TopBarActionButton, TopBarActions } from "@/components/top-bar/top-bar";
import { GooseComposer } from "@/components/chat/goose-composer";
import type {
  ComposerModelSelection,
  ComposerSubmitControls,
  ComposerSubmitPayload,
} from "@/components/chat/composer-types";
import { MessageTimeline } from "@/components/chat/message-timeline";
import { StallNotice } from "@/components/chat/stall-notice";
import { SubagentPanel, useSessionSubagents } from "@/components/chat/subagent-panel";
import { PreviewRail } from "@/components/chat/preview-rail/preview-rail";
import { PREVIEW_PANEL_QUERY_KEY } from "@/lib/preview-rail";
import { activeSubagentCount } from "@/stores/subagents";
import { ConversationWidthControl } from "@/components/chat/conversation-width-control";
import {
  hermesUIMessagesToChatMessages,
  attachTurnStatsMetadata,
  mergeHermesUIMessages,
  messagesResponseToHermesUIMessages,
} from "@/components/chat/message-adapter";
import s from "./detail.module.css";

export function DetailRoute() {
  // URL drives the *initial* selection (deep links, browser back/forward),
  // but `activeSessionIdAtom` is the runtime source of truth. This lets
  // sidebar / history / panel clicks update the atom synchronously and
  // keeps async work (resumeSession, RPCs) from racing the route.
  // See issue #53.
  const { taskId: urlTaskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [activeSessionId, setActiveId] = useAtom(activeSessionIdAtom);
  const [conversationWidthMode, setConversationWidthMode] = useAtom(conversationWidthModeAtom);
  const conversationFontSizeMode = useAtomValue(conversationFontSizeAtom);
  const [rightRailVisible, setRightRailVisible] = useAtom(rightRailVisibleAtom);
  const [searchParams] = useSearchParams();
  const taskId = activeSessionId ?? urlTaskId;
  const turnStats = useSessionTurnStats(taskId);

  const {
    resumeSession,
    sendPrompt,
    interruptSession,
    getSessionUsage,
    compressSession,
    getModelOptions,
    setSessionModel,
    setSessionReasoningEffort,
    attachImage,
    detectDroppedPath,
  } = useGateway();
  const { data: config } = useConfig();
  const { data: modelInfo } = useModelInfo();
  const { data: modelOptionsCache } = useModelOptions();
  const [selectedModel, setSelectedModel] = useState<ComposerModelSelection | null>(null);
  // 思考强度是全局配置（agent.reasoning_effort），不分会话；本地态仅用于
  // 选中后即时反馈，等 config 重新拉到后两者一致。null 表示尚未本地改过，
  // 以配置里的值为准（再读不到则回落到后端默认）。
  const [reasoningEffortOverride, setReasoningEffortOverride] = useState<ReasoningEffort | null>(null);
  const [sessionIdCopyState, setSessionIdCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [sessionTitleOverrides, setSessionTitleOverrides] = useState(readSessionTitleOverrides);
  const sessionIdCopyTimer = useRef<number | null>(null);
  const recoverCompletedTurnFromStoredMessages = useSetAtom(recoverCompletedTurnFromStoredMessagesAtom);
  const appendNotice = useSetAtom(appendNoticeAtom);

  const {
    restSessionId,
    activeMappedGatewaySessionId,
    runtimeSessionId,
    usageGatewaySessionId,
    runtime,
    runtimeIsBusy,
    isLiveSession,
  } = useSessionResolution(taskId);
  const [sessionUsage, setSessionUsage] = useSessionUsagePolling({
    gatewaySessionId: usageGatewaySessionId,
    restSessionId,
    runtimeIsBusy,
    getSessionUsage,
  });

  // 子代理监视（issue #238）：面板按会话 id 读取 subagent 树。store 按事件 session_id
  // (网关会话 id) keyed，故按 detail 解析出的多个候选 id 取首个命中（覆盖 resume 后
  // 持久 id / 网关 id 的形态差异）。
  const [subagentPanelOpen, setSubagentPanelOpen] = useState(false);
  const subagents = useSessionSubagents([
    runtimeSessionId,
    activeMappedGatewaySessionId,
    usageGatewaySessionId,
    taskId,
  ]);
  const subagentActive = activeSubagentCount(subagents);
  const { data: session } = useSession(restSessionId);
  const messagesQuery = useSessionMessages(restSessionId);
  const { data: messagesData, isLoading } = messagesQuery;
  const { data: sessionsData } = useSessions();
  const sessionData = session;
  const sessionSummary = sessionsData?.sessions.find(
    (item) => item.id === restSessionId || item.id === taskId,
  );
  const copyableSessionId = sessionData?.id ?? sessionSummary?.id ?? restSessionId ?? taskId ?? "";

  // Workspace bound to *this* session (#216): prefer the backend's stored cwd
  // (source of truth), then the client-side session→workspace map. Empty string
  // lets the composer fall back to its own default (last-used global workspace).
  const sessionWorkspace = useMemo(
    () => resolveSessionWorkspace(sessionData?.cwd ?? sessionSummary?.cwd, [restSessionId, taskId]),
    [sessionData?.cwd, sessionSummary?.cwd, restSessionId, taskId],
  );

  // Sync URL → atom on mount and whenever URL changes (browser back/forward
  // or a deep-link entry). Sidebar / history clicks already update the atom
  // synchronously *before* navigating, so this only matters for the cases
  // where atom was empty/stale when this component mounted.
  useEffect(() => {
    if (urlTaskId && urlTaskId !== activeSessionId) setActiveId(urlTaskId);
  }, [urlTaskId, activeSessionId, setActiveId]);

  // ⌘B / Ctrl+B toggles the rich-preview right rail (issue #233). A ref holds
  // the latest visibility so the listener stays attached once.
  const railVisibleRef = useRef(rightRailVisible);
  railVisibleRef.current = rightRailVisible;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setRightRailVisible(!railVisibleRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setRightRailVisible]);

  // Deep link: arriving with ?panel=… opens the rail to that tab. Runs once so
  // a later manual close isn't fought by this effect.
  const didAutoOpenRail = useRef(false);
  useEffect(() => {
    if (didAutoOpenRail.current) return;
    didAutoOpenRail.current = true;
    if (searchParams.has(PREVIEW_PANEL_QUERY_KEY) && !railVisibleRef.current) {
      setRightRailVisible(true);
    }
  }, [searchParams, setRightRailVisible]);


  // Reset the user-selected model whenever the route changes to a different
  // session — otherwise the composer chip would carry over the previous
  // session's choice (or the global last-used model) instead of reflecting
  // this session's own model.
  //
  // Prefer a renderer-memory session-model override when present: that's
  // the path panel-composer uses to hand off the just-picked
  // model so detail doesn't briefly show the global default before the
  // backend round-trips back with the real session model.
  //
  // Don't delete the renderer-memory override here — StrictMode runs effects twice
  // (mount → unmount → mount) in dev, and an eager delete on the first run
  // means the second run reads nothing and clobbers selectedModel back to
  // null. The override map dies with the window; per-session-id keys never
  // collide, so leaving stale entries is safe.
  useEffect(() => {
    const override = taskId ? readSessionModelOverride(taskId) : null;
    setSelectedModel(override);
    setSessionUsage(null);
  }, [setSessionUsage, taskId]);

  useEffect(() => {
    return subscribeSessionUiStateChanges(() => {
      setSessionTitleOverrides(readSessionTitleOverrides());
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionIdCopyTimer.current !== null) {
        window.clearTimeout(sessionIdCopyTimer.current);
      }
    };
  }, []);

  const markSessionIdCopyState = useCallback((state: "copied" | "error") => {
    setSessionIdCopyState(state);
    if (sessionIdCopyTimer.current !== null) {
      window.clearTimeout(sessionIdCopyTimer.current);
    }
    sessionIdCopyTimer.current = window.setTimeout(() => {
      setSessionIdCopyState("idle");
      sessionIdCopyTimer.current = null;
    }, 2200);
  }, []);

  const copySessionId = useCallback(async () => {
    if (!copyableSessionId) return;
    try {
      await navigator.clipboard.writeText(copyableSessionId);
      markSessionIdCopyState("copied");
    } catch {
      markSessionIdCopyState("error");
    }
  }, [copyableSessionId, markSessionIdCopyState]);

  const ensureGatewaySession = useCallback(async (): Promise<string> => {
    if (!taskId) throw new Error("缺少会话 ID");
    if (restSessionId && taskId === restSessionId && !activeMappedGatewaySessionId) {
      // No URL navigate after the resume — atom + gwSessionIdAtom hold
      // the authoritative state; downstream callers go through
      // resolveGatewaySessionId / resolvePersistentSessionId helpers
      // which understand both id shapes. The async navigate that used
      // to live here was the source of #52 (closure-stale replace
      // yanking the URL back to the previous session after rapid
      // switches). See #53 for the broader rework.
      return await resumeSession(restSessionId);
    }
    return activeMappedGatewaySessionId ?? taskId;
  }, [activeMappedGatewaySessionId, restSessionId, resumeSession, taskId]);

  const storedMessages = useMemo(
    () => attachTurnStatsMetadata(messagesResponseToHermesUIMessages(messagesData), turnStats),
    [messagesData, turnStats],
  );

  useEffect(() => {
    const sessionId = runtimeSessionId ?? taskId;
    if (!sessionId || !runtimeIsBusy || storedMessages.length === 0) return;
    recoverCompletedTurnFromStoredMessages({
      sessionId,
      storedMessages,
    });
  }, [
    recoverCompletedTurnFromStoredMessages,
    runtimeIsBusy,
    runtimeSessionId,
    storedMessages,
    taskId,
  ]);

  const chatMessages = useMemo(() => {
    const canonical = mergeHermesUIMessages(
      storedMessages,
      isLiveSession ? runtime.messages : [],
    );
    return hermesUIMessagesToChatMessages(canonical);
  }, [
    isLiveSession,
    runtime.messages,
    storedMessages,
  ]);

  // Manual context compaction (/compress). Fire-and-forget so the composer
  // clears immediately; the backend pins a "正在压缩上下文…" status while it
  // works and we surface the before/after result as a system notice.
  const runManualCompress = useCallback(async (sessionId: string, focus: string) => {
    try {
      const result = await compressSession(sessionId, focus);
      appendNotice({ sessionId, text: formatCompressNotice(result, focus), level: "system" });
      // session.compress also emits session.info, but the composer indicator
      // reads polled session.usage — refresh it so the bar/count update now.
      await getSessionUsage(sessionId).then(setSessionUsage).catch(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const busy = message.toLowerCase().includes("session busy");
      appendNotice({
        sessionId,
        text: busy
          ? "当前回合正在进行，请先停止后再压缩上下文。"
          : `压缩上下文失败：${message}`,
        level: busy ? "info" : "error",
      });
    }
  }, [appendNotice, compressSession, getSessionUsage, setSessionUsage]);

  const onSend = useCallback(async (
    payload: ComposerSubmitPayload,
    controls: ComposerSubmitControls,
  ) => {
    if (!taskId) return;
    const builtin = parseBuiltinComposerCommand(payload.text);
    if (builtin?.name === "compress") {
      const sessionId = await ensureGatewaySession();
      void runManualCompress(sessionId, builtin.arg);
      return;
    }
    const gatewaySessionId = await ensureGatewaySession();
    if (payload.workspacePath) {
      rememberWorkspaceProject(payload.workspacePath);
      rememberSessionWorkspace(taskId, payload.workspacePath);
      rememberSessionWorkspace(gatewaySessionId, payload.workspacePath);
      rememberSessionWorkspace(restSessionId, payload.workspacePath);
    }
    const prepared = await prepareComposerPrompt(gatewaySessionId, payload, {
      attachImage,
      detectDroppedPath,
      uploadFile: uploadAttachmentFile,
      onAttachmentUpdate: controls.updateAttachment,
    });
    await sendPrompt(gatewaySessionId, prepared.promptText, {
      displayText: prepared.displayText,
      displayImages: prepared.displayImages,
    });
  }, [attachImage, detectDroppedPath, ensureGatewaySession, restSessionId, runManualCompress, sendPrompt, taskId]);

  // Capability discovery is server-global — don't piggy-back on
  // ensureGatewaySession here. That helper can trigger session.resume, which
  // the backend categorises as a slow handler (tui_gateway/server.py:139,
  // "可达几分钟"). When the underlying agent has crashed or the gateway is
  // mid-reconnect, the resume call hangs and the picker spinner hangs with
  // it. The session_id was only used by the backend to highlight "current
  // model" — useModelInfo gives us that without needing a live session.
  const loadModelOptions = useCallback(
    () => getModelOptions(),
    [getModelOptions],
  );

  const onModelSelect = useCallback(async (selection: ComposerModelSelection) => {
    const gatewaySessionId = await ensureGatewaySession();
    await setSessionModel(gatewaySessionId, selection.model, selection.provider);
    setSelectedModel({
      ...selection,
      contextWindow: resolveModelContextWindow(config, selection),
    });
    recordModelUsage(selection);
    await getSessionUsage(gatewaySessionId)
      .then(setSessionUsage)
      .catch(() => {});
  }, [config, ensureGatewaySession, getSessionUsage, setSessionModel, setSessionUsage]);

  const onConfigureProvider = useCallback((providerId: string) => {
    navigate(`/models#provider-${providerId}`);
  }, [navigate]);

  const configReasoningEffort = useMemo(() => reasoningEffortFromConfig(config), [config]);
  const reasoningEffort = reasoningEffortOverride ?? configReasoningEffort;

  const onReasoningEffortSelect = useCallback(async (effort: ReasoningEffort) => {
    setReasoningEffortOverride(effort); // 立即反馈，等 config 重新拉到后一致
    try {
      const gatewaySessionId = await ensureGatewaySession();
      await setSessionReasoningEffort(gatewaySessionId, effort);
    } catch (error) {
      // 失败则回退到配置里的实际值（override 置空 → 用 configReasoningEffort）
      setReasoningEffortOverride(null);
      console.error("设置思考强度失败：", error);
    }
  }, [ensureGatewaySession, setSessionReasoningEffort]);

  const onStop = useCallback(async () => {
    const sessionId = runtimeSessionId ?? taskId;
    if (!sessionId || !runtimeIsBusy) return;
    await interruptSession(sessionId);
  }, [interruptSession, runtimeIsBusy, runtimeSessionId, taskId]);

  const title = sessionData || sessionSummary
    ? sessionDisplayTitle({
        id: sessionData?.id ?? sessionSummary?.id ?? taskId ?? "",
        title:
          sessionTitleOverrides[sessionData?.id ?? ""] ??
          sessionTitleOverrides[sessionSummary?.id ?? ""] ??
          sessionTitleOverrides[restSessionId ?? ""] ??
          sessionData?.title ??
          sessionSummary?.title,
        preview: sessionData?.preview ?? sessionSummary?.preview,
      })
    : "会话详情";
  const model = selectedModel?.model ?? sessionUsage?.model ?? sessionData?.model ?? "";
  const contextSelection = useMemo<ComposerModelSelection | null>(() => {
    if (selectedModel) return selectedModel;
    if (!model) return null;
    return {
      model,
      provider: modelInfo?.provider,
    };
  }, [model, modelInfo?.provider, selectedModel]);
  const selectedContextMax = useMemo(
    () => resolveModelContextWindow(config, contextSelection),
    [config, contextSelection],
  );
  const pendingApproval = runtime.pendingApprovals[0] ?? null;

  const composerTick = useComposerTimer(runtimeIsBusy, runtime.turnStartedAt);
  // Task-level stall watchdog: detects a turn wedged on a dead provider call
  // (the connection heartbeat can't — the gateway keeps answering pings).
  const stall = useStallWatchdog(runtime);

  const composerLoadingPlaceholder = runtimeIsBusy && runtime.turnStartedAt
    ? `Hermes 思考中 · ${formatElapsedTimer(composerTick)}`
    : undefined;

  const timelineStatus =
    runtime.statusMessage ||
    (runtimeIsBusy && chatMessages.length === 0 ? "任务运行中，等待输出…" : undefined);
  // `session.usage.context_used` 是运行时回报的当前上下文窗口用量，最准确。
  // 刚 resume 的 gw session 可能暂时返回 0，此时只能用当前已渲染消息做近似估算。
  // 不要再回退到 REST `input_tokens + output_tokens`：那是会话累计账单用量，
  // 多轮对话会重复计算历史 prompt，30K 级别上下文很容易被显示成 1M+。
  const estimatedContextUsed = useMemo(
    () => estimateRenderedContextTokens(chatMessages),
    [chatMessages],
  );
  const contextUsage = buildComposerContextUsage({
    live: sessionUsage,
    modelInfo,
    session: sessionData,
    selectedModel,
    selectedContextMax,
    estimatedUsed: estimatedContextUsed,
  });
  const autoTts = voiceAutoTtsFromConfig(config);
  const pageStyle = useMemo(
    () => {
      const font = conversationFontSizeVars(conversationFontSizeMode);
      return {
        "--conversation-max-width": conversationWidthMaxWidth(conversationWidthMode),
        "--conversation-font-size": font.fontSize,
        "--conversation-line-height": font.lineHeight,
      } as CSSProperties;
    },
    [conversationFontSizeMode, conversationWidthMode],
  );

  return (
    <div className={s.page} data-conversation-width={conversationWidthMode} style={pageStyle}>
      <TopBar
        title={title}
        sub={model ? `本会话 ${model}` : undefined}
        right={
          <>
            <ConversationWidthControl
              value={conversationWidthMode}
              onChange={setConversationWidthMode}
            />
            {copyableSessionId ? (
              <TopBarActionButton
                onClick={copySessionId}
                title={`复制会话 ID：${copyableSessionId}`}
                aria-label={`复制会话 ID ${copyableSessionId}`}
              >
                {sessionIdCopyState === "copied" ? (
                  <Check size={12} aria-hidden="true" />
                ) : (
                  <Copy size={12} aria-hidden="true" />
                )}
                <span>
                  {sessionIdCopyState === "copied"
                    ? "已复制"
                    : sessionIdCopyState === "error"
                      ? "复制失败"
                      : "复制会话 ID"}
                </span>
              </TopBarActionButton>
            ) : null}
            <TopBarActionButton
              onClick={() => setSubagentPanelOpen((v) => !v)}
              data-active={subagentPanelOpen ? "true" : undefined}
              title="子代理监视"
              aria-label="子代理监视"
              aria-pressed={subagentPanelOpen}
            >
              <Bot size={12} aria-hidden="true" />
              <span>子代理</span>
              {subagents.length > 0 ? (
                <span className={s.subagentBadge} data-active={subagentActive > 0 ? "true" : undefined}>
                  {subagentActive > 0 ? subagentActive : subagents.length}
                </span>
              ) : null}
            </TopBarActionButton>
            <TopBarActionButton
              onClick={() => setRightRailVisible(!rightRailVisible)}
              data-active={rightRailVisible ? "true" : undefined}
              title="预览面板（⌘B）"
              aria-label="预览面板"
              aria-pressed={rightRailVisible}
            >
              <PanelRight size={12} aria-hidden="true" />
              <span>预览</span>
            </TopBarActionButton>
            <TopBarActions />
          </>
        }
      />
      <div className={s.workArea}>
        <div className={s.chatColumn}>
          {/* key={taskId}：切会话强制重挂载时间线。layout effect 在首帧绘制前就
              把滚动定位到底部，避免新会话内容先以上一个会话的滚动位置绘制、再
              在 650ms 的滚动校正窗口里反复跳动（用户感知为"闪烁两下"）。 */}
          <MessageTimeline
            key={taskId}
            messages={chatMessages}
            loading={isLoading && runtime.messages.length === 0}
            statusMessage={timelineStatus}
            pendingApproval={
              pendingApproval ? (
                <ApprovalDialog approval={pendingApproval} />
              ) : undefined
            }
            turnStartedAt={runtimeIsBusy ? runtime.turnStartedAt : undefined}
            sessionUsage={runtimeIsBusy ? sessionUsage : undefined}
            progressModel={runtimeIsBusy ? model || undefined : undefined}
            autoTts={autoTts}
          />
          <div className={s.composerArea}>
            {runtimeIsBusy && stall.isStalled ? (
              <StallNotice silenceMs={stall.silenceMs} onInterrupt={onStop} />
            ) : null}
            <GooseComposer
              key={taskId}
              initialWorkspacePath={sessionWorkspace}
              onSend={onSend}
              loadingPlaceholder={composerLoadingPlaceholder}
              showMeta={false}
              loading={runtimeIsBusy}
              onStop={onStop}
              voiceConfig={config ?? null}
              modelPicker={{
                selected: contextSelection,
                label: model || modelInfo?.model,
                loadOptions: loadModelOptions,
                initialOptions: modelOptionsCache ?? null,
                onSelect: onModelSelect,
                onConfigureProvider,
                disabled: runtimeIsBusy,
              }}
              reasoningPicker={{
                value: reasoningEffort,
                onSelect: onReasoningEffortSelect,
                disabled: runtimeIsBusy,
              }}
              contextUsage={contextUsage}
            />
          </div>
        </div>
        {rightRailVisible && taskId ? (
          <PreviewRail
            sessionId={taskId}
            workspaceRoot={sessionWorkspace}
            onClose={() => setRightRailVisible(false)}
          />
        ) : null}
        {subagentPanelOpen ? (
          <SubagentPanel subagents={subagents} onClose={() => setSubagentPanelOpen(false)} />
        ) : null}

      </div>
    </div>
  );
}

/* ── Approval Dialog ──────────────────────────────────────────────────── */

function ApprovalDialog({ approval }: { approval: { requestId: string; sessionId: string; command: string; reason?: string } }) {
  const navigate = useNavigate();
  const removeApproval = useSetAtom(removeApprovalAtom);
  const [responding, setResponding] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const respond = async (choice: "approve" | "deny") => {
    if (responding) return;
    setResponding(choice);
    setError(null);
    try {
      await getGatewayClient().request("approval.respond", {
        session_id: approval.sessionId,
        request_id: approval.requestId,
        choice,
      });
      removeApproval({ sessionId: approval.sessionId, requestId: approval.requestId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Failed to respond to approval:", err);
      setError(message || "审批响应发送失败");
    } finally {
      setResponding(null);
    }
  };

  return (
    <div className={s.approvalCard}>
      <div className={s.approvalHeader}>⚠ 需要确认执行</div>
      <div className={s.approvalCommand}>{approval.command}</div>
      {approval.reason && <div className={s.approvalReason}>{approval.reason}</div>}
      {error && <div className={s.approvalError}>发送失败：{error}</div>}
      <div className={s.approvalActions}>
        <button className={s.approvalApprove} onClick={() => respond("approve")} disabled={responding !== null}>
          {responding === "approve" ? "发送中..." : "允许执行"}
        </button>
        <button className={s.approvalDeny} onClick={() => respond("deny")} disabled={responding !== null}>
          {responding === "deny" ? "发送中..." : "拒绝"}
        </button>
        <button className={s.approvalSettings} onClick={() => navigate("/common#approval-mode")} disabled={responding !== null}>
          调整审批模式
        </button>
      </div>
    </div>
  );
}
