import { ProviderError } from "../errors.js";
import type {
  LLM,
  LLMChatParams,
  LLMChatResponse,
  Message,
  ReasoningConfig,
  Tool,
  ToolCall,
  TokenUsage,
  FinishReason,
} from "../types.js";

export interface AnthropicAdapterOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
  /**
   * Per-adapter reasoning configuration. When enabled (and the model supports
   * thinking), the adapter sends the Anthropic `thinking` parameter:
   *
   * - Claude 4.6+ adaptive models: `thinking: { type: "adaptive", display: "summarized" }`
   *   + `output_config: { effort }`.
   * - Legacy (pre-4.6) Claude models: `thinking: { type: "enabled", budget_tokens }`
   *   + `temperature: 1`.
   *
   * When `thinkingBudget`/`adaptiveEffort` are passed directly they take
   * precedence over `reasoningConfig`.
   */
  reasoningConfig?: ReasoningConfig;
  thinkingBudget?: number;
  adaptiveEffort?: "low" | "medium" | "high";
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  id?: string;
  type?: string;
  role?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** Claude models that use adaptive thinking (4.6+). */
function supportsAdaptiveThinking(model: string): boolean {
  const m = (model || "").toLowerCase();
  if (!m.includes("claude")) return false;
  // Legacy manual-thinking Claude families (4.5 and older).
  const legacy = [
    "claude-3",
    "claude-3-5",
    "claude-3-7",
    "claude-4-1",
    "claude-4-3",
    "claude-4-5",
  ];
  return !legacy.some((sub) => m.includes(sub));
}

function isClaudeModel(model: string): boolean {
  return (model || "").toLowerCase().includes("claude");
}

/** Map Hermes effort → Anthropic adaptive effort. */
const ADAPTIVE_EFFORT_MAP: Record<string, "low" | "medium" | "high"> = {
  none: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
  ultra: "high",
};

/** Manual thinking budget per effort level (legacy Claude). */
const THINKING_BUDGET: Record<string, number> = {
  none: 0,
  minimal: 1024,
  low: 4096,
  medium: 8000,
  high: 16000,
  xhigh: 24000,
  max: 32000,
  ultra: 32000,
};

export class AnthropicAdapter implements LLM {
  readonly modelName: string;
  readonly systemPrompt?: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly reasoningConfig?: ReasoningConfig;
  private readonly thinkingBudget?: number;
  private readonly adaptiveEffort?: "low" | "medium" | "high";

  constructor(options: AnthropicAdapterOptions) {
    this.modelName = options.model;
    this.systemPrompt = options.systemPrompt;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.reasoningConfig = options.reasoningConfig;
    this.thinkingBudget = options.thinkingBudget;
    this.adaptiveEffort = options.adaptiveEffort;
  }

  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    const { system, messages: anthropicMessages } = convertMessagesToAnthropic(
      params.messages,
      this.systemPrompt,
    );
    const anthropicTools = convertToolsToAnthropic(params.tools);

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: anthropicMessages,
      max_tokens: 4096,
    };
    if (system) {
      body.system = system;
    }
    if (anthropicTools.length > 0) {
      body.tools = anthropicTools;
      body.tool_choice = { type: "auto" };
    }

    // ── Thinking parameter ─────────────────────────────────────────────
    // Only apply to Claude models; non-Claude Anthropic-compat endpoints
    // (minimax, qwen) keep the manual path only when thinkingBudget is set.
    const thinkingEnabled =
      !!this.reasoningConfig &&
      !this.reasoningConfig.disabled &&
      this.reasoningConfig.enabled !== false;

    if (thinkingEnabled && isClaudeModel(this.modelName) && !this.modelName.toLowerCase().includes("haiku")) {
      const effort = (this.adaptiveEffort ??
        ADAPTIVE_EFFORT_MAP[this.reasoningConfig?.effort ?? "medium"] ??
        "medium") as "low" | "medium" | "high";
      if (supportsAdaptiveThinking(this.modelName)) {
        body.thinking = { type: "adaptive", display: "summarized" };
        body.output_config = { effort };
      } else {
        const budget = this.thinkingBudget ?? THINKING_BUDGET[this.reasoningConfig?.effort ?? "medium"] ?? 8000;
        body.thinking = { type: "enabled", budget_tokens: budget };
        body.temperature = 1;
        body.max_tokens = Math.max(4096, budget + 4096);
      }
    }

    const headers = new Headers({
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    });
    if (this.apiKey) {
      headers.set("x-api-key", this.apiKey);
    }

    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        `Anthropic request failed: ${response.status} ${response.statusText} ${text}`,
        "anthropic",
        response.status,
      );
    }

    const data = (await response.json()) as AnthropicResponse;
    const blocks = data.content ?? [];

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        reasoningParts.push(block.thinking);
      } else if (block.type === "redacted_thinking" && typeof block.data === "string") {
        // Redacted thinking carries no readable content; preserve a marker
        // so downstream knows reasoning happened.
        reasoningParts.push("");
      } else if (block.type === "tool_use") {
        const input = block.input ?? {};
        toolCalls.push({
          id: block.id ?? "",
          name: block.name ?? "",
          arguments: (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>,
          argumentsJson: JSON.stringify(input ?? {}),
        });
      }
    }

    const text = textParts.join("\n");
    const reasoning = reasoningParts.join("\n\n");

    if (reasoning) {
      params.onThinkDelta?.(reasoning);
    }
    if (text) {
      params.onTextDelta?.(text);
    }

    return {
      text,
      reasoning,
      toolCalls,
      providerFinishReason: mapStopReason(data.stop_reason),
      usage: buildAnthropicUsage(data.usage),
    };
  }
}

function mapStopReason(reason?: string): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    case "model_context_window_exceeded":
      return "length";
    default:
      return "unknown";
  }
}

function buildAnthropicUsage(raw: AnthropicResponse["usage"]): TokenUsage {
  if (!raw) return { input: 0, output: 0, total: 0 };
  return {
    input: raw.input_tokens ?? 0,
    output: raw.output_tokens ?? 0,
    total: (raw.input_tokens ?? 0) + (raw.output_tokens ?? 0),
    cacheRead: raw.cache_read_input_tokens,
    cacheWrite: raw.cache_creation_input_tokens,
  };
}

function convertMessagesToAnthropic(
  messages: Message[],
  systemPrompt?: string,
): { system: string; messages: unknown[] } {
  const systemParts: string[] = [];
  if (systemPrompt) systemParts.push(systemPrompt);
  for (const m of messages) {
    if (m.role === "system" && m.content) systemParts.push(m.content);
  }
  const system = systemParts.join("\n\n");

  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.content }] });
    } else if (m.role === "assistant") {
      const content: AnthropicContentBlock[] = [];
      if (m.reasoningContent || m.reasoning) {
        // Replay the thinking block (unsigned on third-party endpoints).
        content.push({ type: "thinking", thinking: m.reasoningContent ?? m.reasoning ?? "" });
      }
      content.push({ type: "text", text: m.content });
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
      }
      out.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
      });
    }
  }
  return { system, messages: out };
}

function convertToolsToAnthropic(tools: readonly Tool[]): unknown[] {
  if (tools.length === 0) return [];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export function createAnthropicAdapter(
  model: string,
  apiKey?: string,
  baseUrl?: string,
): AnthropicAdapter {
  return new AnthropicAdapter({ model, apiKey, baseUrl });
}
