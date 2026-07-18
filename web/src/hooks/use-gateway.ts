import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import {
  ConfigSetResult,
  CommandDispatchResult,
  ImageAttachResult,
  InputDetectDropResult,
  ModelOptionsResult,
  GroupChatCreateResult,
  PromptSubmitParams,
  ProviderModelsListResult,
  ProviderProbeResult,
  SessionCreateResult,
  SessionResumeResult,
  SessionTitleResult,
  SlashCompletionResult,
  SessionUsageResult,
  SessionCompressResult,
  type GatewayEvent,
} from "@hermes/protocol";
import { CN_BACKEND_PROVIDER_SLUGS } from "@/lib/cn-provider-slugs";
import { getGatewayClient } from "@/lib/gateway-client";
import { reattachAfterReconnect } from "@/lib/gateway-reconnect";
import {
  getCachedModelOptions,
  invalidateModelOptionsCache,
} from "@/lib/model-options-cache";
import { buildGatewayModelConfigValue } from "@/lib/provider-id";
import type { ReasoningEffort } from "@/lib/reasoning-effort";
import {
  rememberSessionMapping,
  resolveGatewaySessionId,
  resolvePersistentSessionId,
} from "@/lib/session-map";
import { mirrorSessionWorkspaceMapping } from "@/lib/workspaces";
import { humanizeGatewayError, parseGatewayResult } from "@/lib/gateway-result";
import {
  applyGatewayEventAtom,
  chatRuntimeBySessionAtom,
  ensureChatSessionAtom,
  gwConnectionAtom,
  gwSessionIdAtom,
  markSessionInterruptedAtom,
  markStreamsReconnectingAtom,
  resetChatSessionAtom,
  resetStreamStateAtom,
  setSessionErrorAtom,
  startPromptAtom,
  terminateAllStreamsAtom,
  type ImageEntry,
} from "@/stores/chat";
import { sessionTipRedirectAtom } from "@/stores/ui";
import { recordTipRedirect } from "@/lib/session-tip-redirect";
import { createDeltaCoalescer } from "@/lib/gateway-delta-coalescer";

type GatewayState = ReturnType<typeof getGatewayClient>["state"];

interface GatewaySubscriber {
  setConnectionState: (state: GatewayState) => void;
  applyGatewayEvent: (event: GatewayEvent) => void;
  terminateAllStreams: () => void;
}

interface GatewaySubscriptionBridge {
  subscribers: GatewaySubscriber[];
  unsubscribeState: () => void;
  unsubscribeAny: () => void;
  unsubscribeDisconnect: () => void;
  flushPendingDeltas: () => void;
}

let gatewayBridge: GatewaySubscriptionBridge | null = null;

function primarySubscriber(bridge: GatewaySubscriptionBridge): GatewaySubscriber | undefined {
  return bridge.subscribers[0];
}

function forEachSubscriber(
  bridge: GatewaySubscriptionBridge,
  callback: (subscriber: GatewaySubscriber) => void,
): void {
  for (const subscriber of [...bridge.subscribers]) {
    callback(subscriber);
  }
}

let reattachInFlight = false;

// On a transport reconnect, re-pin the active session's live backend turn by
// re-issuing session.resume (the gateway has no socket-level replay). Runs
// against the default jotai store so it stays single-owner regardless of how
// many components call useGateway(); guarded so overlapping reconnects don't
// fire concurrent resumes. See docs/gateway-connection-overhaul.md (C2).
async function reattachActiveSessionAfterReconnect(): Promise<void> {
  if (reattachInFlight) return;
  reattachInFlight = true;
  const store = getDefaultStore();
  try {
    await reattachAfterReconnect({
      getActiveSessionId: () => store.get(gwSessionIdAtom),
      resolvePersistentId: (id) => resolvePersistentSessionId(id) ?? id,
      resume: async (persistentId) =>
        SessionResumeResult.parse(
          // Resuming can rebuild the agent server-side (minutes-scale, runs in
          // the gateway's long-handler pool) — give it far more than the
          // default request timeout; the UI already shows a transient
          // "reconnecting" state while this is pending.
          await getGatewayClient().request(
            "session.resume",
            { session_id: persistentId },
            { timeoutMs: 300_000 },
          ),
        ),
      onResumed: (gatewaySessionId, persistentId) => {
        store.set(gwSessionIdAtom, gatewaySessionId);
        rememberSessionMapping(gatewaySessionId, persistentId);
      },
      onResumeFailed: () => {
        // The backend session is genuinely gone (reaped / crashed) — escalate
        // the transient "reconnecting" turns to a real error so the UI is honest.
        store.set(terminateAllStreamsAtom);
      },
    });
  } finally {
    reattachInFlight = false;
  }
}

function ensureGatewayBridge(): GatewaySubscriptionBridge {
  if (gatewayBridge) return gatewayBridge;

  const bridge: GatewaySubscriptionBridge = {
    subscribers: [],
    unsubscribeState: () => {},
    unsubscribeAny: () => {},
    unsubscribeDisconnect: () => {},
    flushPendingDeltas: () => {},
  };
  const client = getGatewayClient();
  client.enableAutoReconnect();

  // Coalesce streaming message.delta into one apply per animation frame (see
  // lib/gateway-delta-coalescer). apply() resolves the primary subscriber lazily
  // so a buffered flush always lands on the current chat-store binding.
  const coalescer = createDeltaCoalescer((event) =>
    primarySubscriber(bridge)?.applyGatewayEvent(event),
  );
  bridge.flushPendingDeltas = coalescer.flush;

  // Re-issue session.resume only after a disconnect, never on the very first
  // connect (there is no in-flight state to re-pin yet). `gateway.disconnected`
  // is synthesized by GatewayClient on every unintentional socket close, so
  // arming here and consuming on the next `open` covers exactly the reconnect
  // case. The server re-pins events to the new socket only via session.resume —
  // without it the remaining deltas of an in-flight turn are silently dropped.
  // See docs/gateway-connection-overhaul.md (C2).
  let needsResumeOnReopen = false;

  bridge.unsubscribeState = client.onState((state) => {
    forEachSubscriber(bridge, (sub) => sub.setConnectionState(state));
    if (state === "open" && needsResumeOnReopen) {
      needsResumeOnReopen = false;
      void reattachActiveSessionAfterReconnect();
    }
  });
  bridge.unsubscribeAny = client.onAny((event) => {
    coalescer.dispatch(event);
  });
  bridge.unsubscribeDisconnect = client.on("gateway.disconnected", () => {
    // A disconnect that the transport could not silently recover. Flush any
    // buffered deltas first so the in-flight turn's last tokens aren't stranded,
    // keep the turn alive (don't freeze it as an error), and arm a one-shot
    // session.resume for when the connection comes back.
    coalescer.flush();
    needsResumeOnReopen = true;
    getDefaultStore().set(markStreamsReconnectingAtom);
  });

  gatewayBridge = bridge;
  return bridge;
}

function subscribeGateway(
  setConnectionState: (state: GatewayState) => void,
  applyGatewayEvent: (event: GatewayEvent) => void,
  terminateAllStreams: () => void,
): () => void {
  const bridge = ensureGatewayBridge();
  const subscriber = { setConnectionState, applyGatewayEvent, terminateAllStreams };
  bridge.subscribers.push(subscriber);
  setConnectionState(getGatewayClient().state);

  return () => {
    const index = bridge.subscribers.indexOf(subscriber);
    if (index >= 0) {
      bridge.subscribers.splice(index, 1);
    }
    if (bridge.subscribers.length === 0 && gatewayBridge === bridge) {
      bridge.flushPendingDeltas();
      bridge.unsubscribeState();
      bridge.unsubscribeAny();
      bridge.unsubscribeDisconnect();
      getGatewayClient().disableAutoReconnect();
      gatewayBridge = null;
    }
  };
}

function errorMessage(error: unknown): string {
  return humanizeGatewayError(error);
}

function isSessionBusyError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("session busy");
}

function errorMessageFromUnknown(error: unknown): string {
  return humanizeGatewayError(error);
}

async function rememberPersistentSessionKey(gatewaySessionId: string) {
  try {
    const result = parseGatewayResult(
      SessionTitleResult,
      await getGatewayClient().request("session.title", {
        session_id: gatewaySessionId,
      }),
      "session.title",
    );
    if (result.session_key) {
      rememberSessionMapping(gatewaySessionId, result.session_key);
      mirrorSessionWorkspaceMapping(gatewaySessionId, result.session_key);
    }
  } catch {}
}

interface CreateSessionOptions {
  activate?: boolean;
  cwd?: string;
}

export function useGateway() {
  const queryClient = useQueryClient();
  const connectionState = useAtomValue(gwConnectionAtom);
  const gwSessionId = useAtomValue(gwSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const setConnectionState = useSetAtom(gwConnectionAtom);
  const setGwSessionId = useSetAtom(gwSessionIdAtom);
  const applyGatewayEvent = useSetAtom(applyGatewayEventAtom);
  const ensureChatSession = useSetAtom(ensureChatSessionAtom);
  const resetChatSession = useSetAtom(resetChatSessionAtom);
  const resetStreamState = useSetAtom(resetStreamStateAtom);
  const markSessionInterrupted = useSetAtom(markSessionInterruptedAtom);
  const startPrompt = useSetAtom(startPromptAtom);
  const setSessionError = useSetAtom(setSessionErrorAtom);
  const setSessionTipRedirect = useSetAtom(sessionTipRedirectAtom);
  const terminateAllStreams = useSetAtom(terminateAllStreamsAtom);

  const activeRuntime = gwSessionId ? runtimeBySession[gwSessionId] : undefined;
  const streamStatus = activeRuntime?.streamStatus ?? "idle";

  useEffect(() => {
    return subscribeGateway(setConnectionState, applyGatewayEvent, terminateAllStreams);
  }, [applyGatewayEvent, setConnectionState, terminateAllStreams]);

  const ensureSubscribed = useCallback(() => {
    ensureGatewayBridge();
  }, []);

  const connect = useCallback(async () => {
    ensureSubscribed();
    await getGatewayClient().connect();
  }, [ensureSubscribed]);

  // Pin an already-created gateway session as the live one: target for
  // reconnect-resume (getActiveSessionId reads gwSessionIdAtom), reset its chat
  // runtime, and remember it as the persistent key. Shared by createSession's
  // default activation path and the composer's draft-prewarm reuse, so a
  // pre-created draft is adopted with the exact same state as a fresh create.
  const adoptCreatedSession = useCallback((sessionId: string) => {
    setGwSessionId(sessionId);
    resetChatSession(sessionId);
    void rememberPersistentSessionKey(sessionId);
  }, [resetChatSession, setGwSessionId]);

  const createSession = useCallback(async (options?: CreateSessionOptions): Promise<string> => {
    ensureSubscribed();
    const result = parseGatewayResult(
      SessionCreateResult,
      await getGatewayClient().request("session.create",
        options?.cwd?.trim() ? { cwd: options.cwd.trim() } : {},
      ),
      "session.create",
    );
    if (options?.activate !== false) {
      adoptCreatedSession(result.session_id);
    }
    return result.session_id;
  }, [adoptCreatedSession, ensureSubscribed]);

  const closeSession = useCallback(async (sessionId: string) => {
    if (!sessionId) return;
    ensureSubscribed();
    await getGatewayClient().request("session.close", { session_id: sessionId });
    setGwSessionId((current) => current === sessionId ? null : current);
  }, [ensureSubscribed, setGwSessionId]);

  const beginPrompt = useCallback(
    (sessionId: string, text: string, now?: number, images?: ImageEntry[]) => {
      ensureSubscribed();
      ensureChatSession(sessionId);
      startPrompt({ sessionId, text, now, images });
    },
    [ensureChatSession, ensureSubscribed, startPrompt],
  );

  const failPrompt = useCallback(
    (sessionId: string, error: unknown) => {
      setSessionError({ sessionId, message: errorMessageFromUnknown(error) });
    },
    [setSessionError],
  );

  const resumeSession = useCallback(async (persistentSessionId: string): Promise<string> => {
    ensureSubscribed();
    const result = parseGatewayResult(
      SessionResumeResult,
      await getGatewayClient().request("session.resume", {
        session_id: persistentSessionId,
      }),
      "session.resume",
    );
    const resumed = result.resumed ?? persistentSessionId;
    setGwSessionId(result.session_id);
    resetChatSession(result.session_id);
    rememberSessionMapping(result.session_id, resumed);
    mirrorSessionWorkspaceMapping(result.session_id, resumed);
    // Compression rotated the conversation onto a new continuation: the backend
    // followed the chain and resumed a different persistent id than we asked
    // for. Record it so the detail route can project onto the live tip instead
    // of stranding the user on the now-empty pre-compression id (issue #305).
    setSessionTipRedirect((prev) => recordTipRedirect(prev, persistentSessionId, result.resumed));
    return result.session_id;
  }, [ensureSubscribed, resetChatSession, setGwSessionId, setSessionTipRedirect]);

  const sendPrompt = useCallback(
    async (
      sessionId: string,
      text: string,
      options?: {
        displayText?: string;
        images?: string[];
        displayImages?: ImageEntry[];
        skipOptimisticStart?: boolean;
      },
    ) => {
      ensureSubscribed();
      ensureChatSession(sessionId);
      if (!options?.skipOptimisticStart) {
        startPrompt({
          sessionId,
          text: options?.displayText ?? text,
          images: options?.displayImages,
        });
      }

      try {
        const params = PromptSubmitParams.parse({
          session_id: sessionId,
          text,
          ...(options?.images?.length ? { images: options.images } : {}),
        });

        try {
          await getGatewayClient().request("prompt.submit", params);
        } catch (err) {
          if (isSessionBusyError(err)) {
            await getGatewayClient().request(
              "session.interrupt",
              { session_id: sessionId },
              { timeoutMs: 10_000 },
            );
            resetStreamState(sessionId);
            await getGatewayClient().request("prompt.submit", params);
          } else {
            throw err;
          }
        }

        await rememberPersistentSessionKey(sessionId);
      } catch (error) {
        setSessionError({ sessionId, message: errorMessage(error) });
        throw error;
      }
    },
    [ensureChatSession, ensureSubscribed, resetStreamState, setSessionError, startPrompt],
  );

  // Group chat (P-048): create a room from profile names and adopt it as the
  // active session (room_id doubles as the session id, gc_-prefixed by Core).
  const createGroupChat = useCallback(
    async (members: string[], title?: string): Promise<GroupChatCreateResult> => {
      ensureSubscribed();
      const result = parseGatewayResult(
        GroupChatCreateResult,
        await getGatewayClient().request("groupchat.create", {
          members,
          ...(title?.trim() ? { title: title.trim() } : {}),
        }),
        "groupchat.create",
      );
      adoptCreatedSession(result.room_id);
      return result;
    },
    [adoptCreatedSession, ensureSubscribed],
  );

  // Group chat (P-048): send into a room. Mentioned members reply serially,
  // each as its own sender-tagged message.* stream over the same session id.
  const sendGroupPrompt = useCallback(
    async (roomId: string, text: string, options?: { skipOptimisticStart?: boolean }) => {
      ensureSubscribed();
      ensureChatSession(roomId);
      if (!options?.skipOptimisticStart) {
        startPrompt({ sessionId: roomId, text });
      }
      try {
        await getGatewayClient().request("groupchat.submit", { room_id: roomId, text });
      } catch (error) {
        setSessionError({ sessionId: roomId, message: errorMessage(error) });
        throw error;
      }
    },
    [ensureChatSession, ensureSubscribed, setSessionError, startPrompt],
  );

  // Group chat (P-048): fetch a room's members (survives reload — the room
  // lives in the gateway process, not the DB).
  const groupChatInfo = useCallback(
    async (roomId: string): Promise<GroupChatCreateResult> => {
      ensureSubscribed();
      return parseGatewayResult(
        GroupChatCreateResult,
        await getGatewayClient().request("groupchat.info", { room_id: roomId }),
        "groupchat.info",
      );
    },
    [ensureSubscribed],
  );

  const getSessionUsage = useCallback(
    async (sessionId: string): Promise<SessionUsageResult> => {
      ensureSubscribed();
      return parseGatewayResult(
        SessionUsageResult,
        await getGatewayClient().request("session.usage", { session_id: sessionId }),
        "session.usage",
      );
    },
    [ensureSubscribed],
  );

  const compressSession = useCallback(
    async (
      sessionId: string,
      focusTopic?: string,
    ): Promise<SessionCompressResult> => {
      ensureSubscribed();
      const focus = focusTopic?.trim();
      return parseGatewayResult(
        SessionCompressResult,
        await getGatewayClient().request(
          "session.compress",
          {
            session_id: sessionId,
            ...(focus ? { focus_topic: focus } : {}),
          },
          // Compaction summarises the whole history through the model; the
          // backend classifies it as a slow handler, so give it room.
          { timeoutMs: 180_000 },
        ),
        "session.compress",
      );
    },
    [ensureSubscribed],
  );

  const getModelOptions = useCallback(
    async (sessionId?: string): Promise<ModelOptionsResult> => {
      ensureSubscribed();
      return getCachedModelOptions(
        sessionId,
        async () => parseGatewayResult(
          ModelOptionsResult,
          await getGatewayClient().request(
            "model.options",
            {
              slug_filter: CN_BACKEND_PROVIDER_SLUGS,
              ...(sessionId ? { session_id: sessionId } : {}),
            },
          ),
          "model.options",
        ),
      );
    },
    [ensureSubscribed],
  );

  const completeSlash = useCallback(
    async (text: string): Promise<SlashCompletionResult> => {
      ensureSubscribed();
      return parseGatewayResult(
        SlashCompletionResult,
        await getGatewayClient().request("complete.slash", { text }),
        "complete.slash",
      );
    },
    [ensureSubscribed],
  );

  // `@`-reference completion (files / folders / url / git starters). Mirrors the
  // backend `complete.path` used by the official desktop: a bare "@" returns the
  // reference starters, "@file:<basename>" fuzzy-matches repo files. `cwd` scopes
  // the search to the composer's selected workspace; both args are optional.
  const completePath = useCallback(
    async (
      word: string,
      opts?: { sessionId?: string; cwd?: string },
    ): Promise<SlashCompletionResult> => {
      ensureSubscribed();
      const params: { word: string; session_id?: string; cwd?: string } = { word };
      if (opts?.sessionId) params.session_id = opts.sessionId;
      if (opts?.cwd) params.cwd = opts.cwd;
      return parseGatewayResult(
        SlashCompletionResult,
        await getGatewayClient().request("complete.path", params),
        "complete.path",
      );
    },
    [ensureSubscribed],
  );

  const dispatchCommand = useCallback(
    async (
      sessionId: string,
      name: string,
      arg = "",
    ): Promise<CommandDispatchResult> => {
      ensureSubscribed();
      return parseGatewayResult(
        CommandDispatchResult,
        await getGatewayClient().request("command.dispatch", {
          session_id: sessionId,
          name,
          arg,
        }),
        "command.dispatch",
      );
    },
    [ensureSubscribed],
  );

  const probeProvider = useCallback(
    async (params: {
      provider: string;
      api_key?: string;
      base_url?: string;
      /** "anthropic_messages" 让后端用 Anthropic 协议（x-api-key + /v1/models）探测。 */
      api_mode?: string;
      timeout_ms?: number;
    }): Promise<ProviderProbeResult> => {
      ensureSubscribed();
      return parseGatewayResult(
        ProviderProbeResult,
        await getGatewayClient().request("provider.probe", params),
        "provider.probe",
      );
    },
    [ensureSubscribed],
  );

  // List a provider's full model set from the backend (which has no
  // external-request SSRF guard), so a self-hosted provider on a LAN IP — and
  // the web shell, which can't fetch it cross-origin — can refresh the picker.
  const listProviderModels = useCallback(
    async (params: {
      provider: string;
      api_key?: string;
      base_url?: string;
      /** "anthropic_messages" 让后端用 Anthropic 协议（x-api-key + /v1/models）列模型。 */
      api_mode?: string;
      timeout_ms?: number;
    }): Promise<ProviderModelsListResult> => {
      ensureSubscribed();
      return parseGatewayResult(
        ProviderModelsListResult,
        await getGatewayClient().request("provider.models", params),
        "provider.models",
      );
    },
    [ensureSubscribed],
  );

  const setSessionModel = useCallback(
    async (
      sessionId: string,
      model: string,
      provider?: string,
    ): Promise<ConfigSetResult> => {
      ensureSubscribed();
      const value = buildGatewayModelConfigValue(model, provider);
      const result = parseGatewayResult(
        ConfigSetResult,
        await getGatewayClient().request("config.set", {
          session_id: sessionId,
          key: "model",
          value,
        }),
        "config.set",
      );
      invalidateModelOptionsCache(sessionId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["session"] }),
        queryClient.invalidateQueries({ queryKey: ["model-info"] }),
      ]);
      return result;
    },
    [ensureSubscribed, queryClient],
  );

  const setRuntimeModel = useCallback(
    async (
      model: string,
      provider?: string,
    ): Promise<ConfigSetResult> => {
      ensureSubscribed();
      const result = parseGatewayResult(
        ConfigSetResult,
        await getGatewayClient().request("config.set", {
          key: "model",
          value: buildGatewayModelConfigValue(model, provider),
        }),
        "config.set",
      );
      invalidateModelOptionsCache();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["session"] }),
        queryClient.invalidateQueries({ queryKey: ["model-info"] }),
      ]);
      return result;
    },
    [ensureSubscribed, queryClient],
  );

  // 思考强度走和模型选择同一条路：网关 config.set（key="reasoning"）。
  // 后端会把字面档位写进 config.yaml 的 agent.reasoning_effort，并即时更新
  // 该会话在内存里的 agent.reasoning_config，从而下一轮对话生效。
  // （PUT /api/config 只落盘、不热更新当前会话，不满足"下一轮生效"。）
  const setSessionReasoningEffort = useCallback(
    async (sessionId: string, effort: ReasoningEffort): Promise<ConfigSetResult> => {
      ensureSubscribed();
      const result = parseGatewayResult(
        ConfigSetResult,
        await getGatewayClient().request("config.set", {
          session_id: sessionId,
          key: "reasoning",
          value: effort,
        }),
        "config.set",
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["config"] }),
        queryClient.invalidateQueries({ queryKey: ["model-info"] }),
      ]);
      return result;
    },
    [ensureSubscribed, queryClient],
  );

  const attachImage = useCallback(
    async (sessionId: string, path: string): Promise<ImageAttachResult> => {
      ensureSubscribed();
      return parseGatewayResult(
        ImageAttachResult,
        await getGatewayClient().request("image.attach", {
          session_id: sessionId,
          path,
        }),
        "image.attach",
      );
    },
    [ensureSubscribed],
  );

  // Attach an image by uploading its bytes over the gateway (image.attach_bytes),
  // mirroring the official desktop's remote path. Used when the image is an
  // in-browser File with no gateway-readable filesystem path (e.g. a pasted
  // screenshot) — avoids the fork-only REST /api/upload endpoint, which keeps
  // getting dropped/restored across Core upstream syncs.
  const attachImageBytes = useCallback(
    async (
      sessionId: string,
      contentBase64: string,
      filename?: string,
    ): Promise<ImageAttachResult> => {
      ensureSubscribed();
      return parseGatewayResult(
        ImageAttachResult,
        await getGatewayClient().request("image.attach_bytes", {
          session_id: sessionId,
          content_base64: contentBase64,
          ...(filename ? { filename } : {}),
        }),
        "image.attach_bytes",
      );
    },
    [ensureSubscribed],
  );

  const detectDroppedPath = useCallback(
    async (sessionId: string, path: string): Promise<InputDetectDropResult> => {
      ensureSubscribed();
      return parseGatewayResult(
        InputDetectDropResult,
        await getGatewayClient().request("input.detect_drop", {
          session_id: sessionId,
          text: path,
        }),
        "input.detect_drop",
      );
    },
    [ensureSubscribed],
  );

  const interruptSession = useCallback(
    async (sessionId: string) => {
      const gatewaySessionId = resolveGatewaySessionId(sessionId) ?? sessionId;
      if (!gatewaySessionId) return;
      ensureSubscribed();

      try {
        await getGatewayClient().request(
          "session.interrupt",
          { session_id: gatewaySessionId },
          { timeoutMs: 10_000 },
        );
      } catch (error) {
        setSessionError({ sessionId: gatewaySessionId, message: errorMessage(error) });
        throw error;
      }

      markSessionInterrupted(gatewaySessionId);
    },
    [ensureSubscribed, markSessionInterrupted, setSessionError],
  );

  const setSessionTitle = useCallback(
    async (sessionId: string, title: string) => {
      const cleanTitle = title.trim();
      if (!sessionId || !cleanTitle) return;
      ensureSubscribed();
      const result = parseGatewayResult(
        SessionTitleResult,
        await getGatewayClient().request("session.title", {
          session_id: sessionId,
          title: cleanTitle,
        }),
        "session.title",
      );
      if (result.session_key) {
        rememberSessionMapping(sessionId, result.session_key);
        mirrorSessionWorkspaceMapping(sessionId, result.session_key);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["session"] }),
      ]);
      return result.title ?? cleanTitle;
    },
    [ensureSubscribed, queryClient],
  );

  const disconnect = useCallback(() => {
    getGatewayClient().close();
    setGwSessionId(null);
  }, [setGwSessionId]);

  return {
    connectionState,
    gwSessionId,
    streamStatus,
    connect,
    createSession,
    adoptCreatedSession,
    closeSession,
    beginPrompt,
    failPrompt,
    resumeSession,
    sendPrompt,
    createGroupChat,
    sendGroupPrompt,
    groupChatInfo,
    getSessionUsage,
    compressSession,
    getModelOptions,
    completeSlash,
    completePath,
    dispatchCommand,
    probeProvider,
    listProviderModels,
    setSessionModel,
    setRuntimeModel,
    setSessionReasoningEffort,
    attachImage,
    attachImageBytes,
    detectDroppedPath,
    interruptSession,
    setSessionTitle,
    disconnect,
  };
}
