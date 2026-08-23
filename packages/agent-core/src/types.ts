/**
 * Core data types for the in-process agent loop.
 *
 * These mirror the Python `AIAgent`/`conversation_loop` wire shapes and the
 * Desktop `GatewayEvent` schemas in `@hermes/protocol`.  They are intentionally
 * transport-agnostic so the same loop can run in the Tauri webview, a future
 * CLI port, or a test harness.
 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  id?: string;
  role: MessageRole;
  content: string;
  images?: unknown[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  timestamp?: number;
  tokenCount?: number;
  finishReason?: string;
  reasoning?: string;
  reasoningContent?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentsJson?: string;
}

export interface ToolCallDelta {
  id?: string;
  index?: number;
  name?: string;
  arguments?: string;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "unknown";

export interface TokenUsage {
  input: number;
  output: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export interface ToolParameterSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolContext {
  sessionId: string;
  runtime?: unknown;
  signal?: AbortSignal;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}

export interface LLMRequestTraceState {
  requestId?: string;
  startedAt?: number;
  provider?: string;
  model?: string;
}

export interface LLMChatParams {
  messages: Message[];
  tools: readonly Tool[];
  signal?: AbortSignal;
  /** When true, request a streaming response (SSE deltas). */
  stream?: boolean;
  onTextDelta?(delta: string): void;
  onThinkDelta?(delta: string): void;
  onToolCallDelta?(delta: ToolCallDelta): void;
  trace?: LLMRequestTraceState;
}

export interface LLMChatResponse {
  text: string;
  toolCalls: ToolCall[];
  providerFinishReason?: FinishReason;
  usage: TokenUsage;
  /**
   * Reasoning / chain-of-thought text extracted from the provider response.
   *
   * - OpenAI-compatible (DeepSeek, Moonshot): the `reasoning_content` field.
   * - Anthropic: concatenated `thinking` block text.
   * - OpenAI Responses: concatenated `reasoning_text` content.
   *
   * Empty string when the model produced no thinking block. Always paired with
   * a non-empty `text` for a successful reasoning turn.
   */
  reasoning?: string;
}

export interface LLM {
  readonly modelName: string;
  readonly systemPrompt?: string;
  chat(params: LLMChatParams): Promise<LLMChatResponse>;
}

export type ProviderApiMode =
  | "chat_completions"
  | "codex_responses"
  | "anthropic_messages"
  | "bedrock_converse"
  | "codex_app_server";

export interface ReasoningConfig {
  effort?: "low" | "medium" | "high";
  budgetTokens?: number;
  disabled?: boolean;
  /** When true, reasoning/thinking is explicitly enabled. */
  enabled?: boolean;
}

export interface PlatformIdentity {
  platform?: string;
  userId?: string;
  chatId?: string;
  gatewaySessionKey?: string;
}

export type ContextFileSource = "hermes" | "agents" | "claude" | "cursor" | "soul";

/**
 * A loaded project context file.  The runtime uses this to inject context into
 * the system prompt on the first turn of a session.
 */
export interface ContextFile {
  /** Absolute filesystem path of the loaded file. */
  path: string;
  /** Which family of context file this is (used for priority / merge rules). */
  source: ContextFileSource;
  /** File content as UTF-8 text. */
  content: string;
  /** Human-readable provenance label (e.g. `AGENTS.md`, `../AGENTS.md`). */
  provenance?: string;
}

/**
 * A session snapshot binds model + provider config + enabled toolsets + skills +
 * memory scope + platform identity.  It is the TS equivalent of Core's
 * `sessions.model_config` + `profile_name` row.
 */
export interface ProfileSnapshot {
  model: string;
  provider: string;
  apiMode: ProviderApiMode;
  baseUrl?: string;
  apiKey?: string;
  enabledToolsets?: string[];
  disabledToolsets?: string[];
  skills?: string[];
  memoryProvider?: string;
  reasoningConfig?: ReasoningConfig;
  platformIdentity?: PlatformIdentity;
  /** Project context files discovered for this session. */
  contextFiles?: ContextFile[];
  [key: string]: unknown;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  prompt: string;
  startedAt: number;
  completedAt?: number;
  usage: TokenUsage;
  stopReason: string;
  stepCount: number;
}
