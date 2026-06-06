import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import {
  ConfigSetResult,
  ImageAttachResult,
  InputDetectDropResult,
  ModelOptionsResult,
  PromptSubmitParams,
  ProviderProbeResult,
  SessionCreateResult,
  SessionResumeResult,
  SessionTitleResult,
  SessionUsageResult,
  type GatewayEvent,
} from "@hermes/protocol";
import { CN_BACKEND_PROVIDER_SLUGS } from "@/lib/cn-provider-slugs";
import { getGatewayClient } from "@/lib/gateway-client";
import {
  getCachedModelOptions,
  invalidateModelOptionsCache,
} from "@/lib/model-options-cache";
import { buildGatewayModelConfigValue } from "@/lib/provider-id";
import { rememberSessionMapping, resolveGatewaySessionId } from "@/lib/session-map";
import { mirrorSessionWorkspaceMapping } from "@/lib/workspaces";
import { humanizeGatewayError, parseGatewayResult } from "@/lib/gateway-result";
import {
  applyGatewayEventAtom,
  chatRuntimeBySessionAtom,
  ensureChatSessionAtom,
  gwConnectionAtom,
  gwSessionIdAtom,
  resetChatSessionAtom,
  resetStreamStateAtom,
  setSessionErrorAtom,
  startPromptAtom,
  terminateAllStreamsAtom,
  type ImageEntry,
} from "@/stores/chat";

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

function ensureGatewayBridge(): GatewaySubscriptionBridge {
  if (gatewayBridge) return gatewayBridge;

  const bridge: GatewaySubscriptionBridge = {
    subscribers: [],
    unsubscribeState: () => {},
    unsubscribeAny: () => {},
    unsubscribeDisconnect: () => {},
  };
  const client = getGatewayClient();
  client.enableAutoReconnect();

  bridge.unsubscribeState = client.onState((state) =>
    forEachSubscriber(bridge, (sub) => sub.setConnectionState(state)));
  bridge.unsubscribeAny = client.onAny((event) => {
    primarySubscriber(bridge)?.applyGatewayEvent(event);
  });
  bridge.unsubscribeDisconnect = client.on("gateway.disconnected", () =>
    forEachSubscriber(bridge, (sub) => sub.terminateAllStreams()));
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
  const startPrompt = useSetAtom(startPromptAtom);
  const setSessionError = useSetAtom(setSessionErrorAtom);
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

  const createSession = useCallback(async (options?: CreateSessionOptions): Promise<string> => {
    ensureSubscribed();
    const result = parseGatewayResult(
      SessionCreateResult,
      await getGatewayClient().request("session.create", {}),
      "session.create",
    );
    if (options?.activate !== false) {
      setGwSessionId(result.session_id);
      resetChatSession(result.session_id);
      void rememberPersistentSessionKey(result.session_id);
    }
    return result.session_id;
  }, [ensureSubscribed, resetChatSession, setGwSessionId]);

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
    setGwSessionId(result.session_id);
    resetChatSession(result.session_id);
    rememberSessionMapping(result.session_id, result.resumed ?? persistentSessionId);
    mirrorSessionWorkspaceMapping(result.session_id, result.resumed ?? persistentSessionId);
    return result.session_id;
  }, [ensureSubscribed, resetChatSession, setGwSessionId]);

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

  const probeProvider = useCallback(
    async (params: {
      provider: string;
      api_key?: string;
      base_url?: string;
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
    },
    [ensureSubscribed, setSessionError],
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
    closeSession,
    beginPrompt,
    failPrompt,
    resumeSession,
    sendPrompt,
    getSessionUsage,
    getModelOptions,
    probeProvider,
    setSessionModel,
    setRuntimeModel,
    attachImage,
    detectDroppedPath,
    interruptSession,
    setSessionTitle,
    disconnect,
  };
}
