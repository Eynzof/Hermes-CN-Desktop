import { createEventEmitter, type AgentEvent, type AgentEventEmitter } from "../events.js";
import { runTurn, type RunTurnResult } from "../run-turn.js";
import type { LLM, Message, Tool, TokenUsage } from "../types.js";
import type { ProviderProfile } from "../providers/profile.js";
import { getProvider, listProviders } from "../providers/registry.js";
import { InMemorySessionStore, type AgentSession, type AgentSessionMessage, type CreateSessionOptions, type SessionStore } from "../session/store.js";
import type { ProfileSnapshot } from "../types.js";
import { AgentError } from "../errors.js";

export interface AgentRuntimeOptions {
  store?: SessionStore;
  tools?: Tool[];
  llmFactory?: LLMFactory;
  systemPrompt?: string;
  maxSteps?: number;
}

export type LLMFactory = (profile: ProfileSnapshot) => LLM | undefined;

export interface SubmitPromptResult {
  turnId: string;
  text: string;
  usage: TokenUsage;
  stopReason: string;
}

export interface RuntimeModelInfo {
  provider: string;
  model: string;
  capabilities?: Record<string, unknown>;
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

function sessionMessageToMessage(message: AgentSessionMessage): Message {
  return {
    id: message.id,
    role: message.role as Message["role"],
    content: message.content,
    images: message.images,
    toolCallId: message.toolCallId,
    toolCalls: message.toolCalls as Array<{ id: string; name: string; arguments: Record<string, unknown> }> | undefined,
    toolName: message.toolName,
    timestamp: message.timestamp,
    tokenCount: message.tokenCount,
    finishReason: message.finishReason,
    reasoning: message.reasoning,
    reasoningContent: message.reasoningContent,
  };
}

function messageToSessionMessage(sessionId: string, message: Message): AgentSessionMessage {
  return {
    id: message.id ?? randomId(),
    sessionId,
    role: message.role,
    content: message.content,
    images: message.images,
    toolCallId: message.toolCallId,
    toolCalls: message.toolCalls,
    toolName: message.toolName,
    timestamp: message.timestamp ?? Date.now(),
    tokenCount: message.tokenCount,
    finishReason: message.finishReason,
    reasoning: message.reasoning,
    reasoningContent: message.reasoningContent,
  };
}

/**
 * Host-agnostic façade for the in-process agent core.
 *
 * `AgentRuntime` is the drop-in replacement for the WebSocket gateway client:
 * hosts create/resume sessions, submit prompts, and receive `AgentEvent`s
 * (which reuse the `GatewayEvent` shape so existing desktop reducers keep
 * working).
 */
export class AgentRuntime {
  private readonly store: SessionStore;
  private readonly tools: Tool[];
  private readonly llmFactory: LLMFactory;
  private readonly systemPrompt?: string;
  private readonly maxSteps: number;
  private readonly emitter: AgentEventEmitter;
  private readonly activeTurns = new Map<string, AbortController>();

  constructor(options: AgentRuntimeOptions = {}) {
    this.store = options.store ?? new InMemorySessionStore();
    this.tools = options.tools ?? [];
    this.llmFactory = options.llmFactory ?? defaultLLMFactory;
    this.systemPrompt = options.systemPrompt;
    this.maxSteps = options.maxSteps ?? 32;
    this.emitter = createEventEmitter();
  }

  on(listener: (event: AgentEvent) => void): () => void {
    return this.emitter.on(listener);
  }

  private emit(event: AgentEvent): void {
    this.emitter.emit(event);
  }

  async createSession(profile: ProfileSnapshot, options?: CreateSessionOptions): Promise<AgentSession> {
    const session = await this.store.createSession(profile, options);
    this.emit({
      type: "session.info",
      session_id: session.id,
      payload: {
        model: session.profile.model,
        provider: session.profile.provider,
      },
    });
    return session;
  }

  async resumeSession(sessionId: string): Promise<AgentSession | undefined> {
    const session = await this.store.getSession(sessionId);
    if (!session) return undefined;
    this.emit({
      type: "session.info",
      session_id: session.id,
      payload: {
        model: session.profile.model,
        provider: session.profile.provider,
      },
    });
    return session;
  }

  async submitPrompt(sessionId: string, prompt: string): Promise<SubmitPromptResult> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new AgentError(`Session ${sessionId} not found`, "session_not_found");
    }

    const llm = this.llmFactory(session.profile);
    if (!llm) {
      throw new AgentError(
        `No LLM adapter available for provider "${session.profile.provider}"`,
        "provider_not_available",
      );
    }

    const turnId = randomId();
    const controller = new AbortController();
    this.activeTurns.set(sessionId, controller);

    try {
      const historyMessages = await this.store.getMessages(sessionId);
      const history = historyMessages.map(sessionMessageToMessage);

      const userMessage: Message = {
        id: randomId(),
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      };
      await this.store.appendMessage(messageToSessionMessage(sessionId, userMessage));

      const result = await runTurn({
        sessionId,
        turnId,
        prompt,
        llm,
        messages: history,
        tools: this.tools,
        systemPrompt: this.systemPrompt,
        contextFiles: session.profile.contextFiles,
        maxSteps: this.maxSteps,
        signal: controller.signal,
        emit: (event) => this.emit(event),
      });

      await this.store.appendMessage(messageToSessionMessage(sessionId, result.assistantMessage));

      session.messageCount += result.steps.length;
      session.inputTokens += result.usage.input;
      session.outputTokens += result.usage.output;
      if (result.assistantMessage.content && result.assistantMessage.content.length > 0) {
        session.preview = result.assistantMessage.content.slice(0, 200);
      }
      await this.store.saveSession(session);

      return {
        turnId,
        text: result.assistantMessage.content,
        usage: result.usage,
        stopReason: result.stopReason,
      };
    } finally {
      this.activeTurns.delete(sessionId);
    }
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const controller = this.activeTurns.get(sessionId);
    if (!controller) return false;
    controller.abort();
    this.emit({
      type: "agent.status",
      session_id: sessionId,
      payload: { kind: "interrupted", text: "Turn interrupted by user" },
    });
    return true;
  }

  async switchModel(sessionId: string, model: string, provider?: string): Promise<AgentSession | undefined> {
    const session = await this.store.getSession(sessionId);
    if (!session) return undefined;
    session.profile.model = model;
    if (provider) {
      session.profile.provider = provider;
      const profile = getProvider(provider);
      if (profile?.apiMode) {
        session.profile.apiMode = profile.apiMode;
      }
    }
    await this.store.saveSession(session);
    this.emit({
      type: "session.info",
      session_id: sessionId,
      payload: { model, provider: session.profile.provider },
    });
    return session;
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    const models: RuntimeModelInfo[] = [];
    for (const provider of listProviders()) {
      const providerModels = provider.model ? [provider.model] : [];
      for (const model of providerModels.concat(provider.fallbackModels ?? [])) {
        models.push({
          provider: provider.slug,
          model,
          capabilities: provider.capabilities as Record<string, unknown> | undefined,
        });
      }
    }
    return models;
  }

  getStore(): SessionStore {
    return this.store;
  }
}

function defaultLLMFactory(profile: ProfileSnapshot): LLM | undefined {
  const provider = getProvider(profile.provider);
  if (!provider) return undefined;

  switch (provider.apiMode) {
    case "chat_completions":
      // Deferred: a real runtime wires in an OpenAIChatAdapter here.  Returning
      // undefined keeps the scaffold honest (the caller must provide an
      // `llmFactory` or register a functional provider profile).
      return undefined;
    default:
      return undefined;
  }
}

export { InMemorySessionStore, type SessionStore, type AgentSession };
