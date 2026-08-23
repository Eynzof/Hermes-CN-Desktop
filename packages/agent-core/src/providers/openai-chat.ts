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

export interface OpenAIChatAdapterOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
  /**
   * Per-adapter reasoning configuration. When set (and not disabled), the
   * adapter sends `reasoning_effort` and `extra_body.thinking` so
   * OpenAI-compatible thinking models (DeepSeek V4, Kimi, Moonshot) emit a
   * `reasoning_content` block alongside the visible text.
   */
  reasoningConfig?: ReasoningConfig;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChatChoice {
  message?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason?: string;
}

interface OpenAIChatCompletion {
  choices: Array<OpenAIChatChoice>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_read_tokens?: number;
    prompt_cache_write_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/** Reasoning-content deltas arrive on `delta.reasoning_content`. */
interface OpenAIChatStreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}
interface OpenAIChatStreamChunk {
  choices?: Array<{
    delta?: OpenAIChatStreamDelta;
    finish_reason?: string | null;
  }>;
  usage?: OpenAIChatCompletion["usage"];
}

/**
 * True when the model name is a DeepSeek V4+ family that accepts
 * `extra_body.thinking={"type":"enabled"}` and returns `reasoning_content`.
 * Matches the Python DeepSeekProfile._model_supports_thinking gate so the
 * wire shape stays in lock-step with Core.
 */
function deepseekModelSupportsThinking(model: string): boolean {
  const m = (model || "").trim().toLowerCase();
  if (!m) return false;
  // deepseek-v4-*, deepseek-v5-*, ... — every V4+ generation has thinking.
  // v3 is explicitly excluded (non-thinking wire format).
  return m.startsWith("deepseek-v") && !m.startsWith("deepseek-v3");
}

/**
 * Resolve the wire `reasoning_effort` value for the request body.
 * Returns null when reasoning is disabled or no effort was configured.
 */
function resolveReasoningEffort(
  reasoningConfig?: ReasoningConfig,
): "low" | "medium" | "high" | "max" | null {
  if (!reasoningConfig) return null;
  if (reasoningConfig.disabled) return null;
  if (reasoningConfig.enabled === false) return null;
  const effort = reasoningConfig.effort;
  if (!effort) return "medium"; // default when enabled but no effort set
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  return "medium";
}

/**
 * Build the `extra_body` payload for thinking models. DeepSeek V4 requires
 * `extra_body.thinking={"type":"enabled"|"disabled"}` to toggle the
 * `reasoning_content` channel; without it the API defaults to thinking ON
 * and enforces the reasoning_content echo contract on subsequent turns.
 */
function buildThinkingExtraBody(
  model: string,
  reasoningConfig?: ReasoningConfig,
): Record<string, unknown> | undefined {
  if (!deepseekModelSupportsThinking(model)) return undefined;
  const enabled =
    !!reasoningConfig &&
    !reasoningConfig.disabled &&
    reasoningConfig.enabled !== false;
  return { thinking: { type: enabled ? "enabled" : "disabled" } };
}

export class OpenAIChatAdapter implements LLM {
  readonly modelName: string;
  readonly systemPrompt?: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly reasoningConfig?: ReasoningConfig;

  constructor(options: OpenAIChatAdapterOptions) {
    this.modelName = options.model;
    this.systemPrompt = options.systemPrompt;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.reasoningConfig = options.reasoningConfig;
  }

  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    const stream = params.stream ?? false;
    if (stream) {
      return this.chatStream(params);
    }
    return this.chatNonStream(params);
  }

  private buildBody(params: LLMChatParams, stream: boolean): Record<string, unknown> {
    const messages = buildOpenAIMessages(params.messages, this.systemPrompt);
    const tools = params.tools.length > 0 ? params.tools.map(toolToOpenAI) : undefined;

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages,
      stream,
    };
    if (tools) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    // Reasoning / thinking. DeepSeek V4+ takes `reasoning_effort` at the top
    // level and `extra_body.thinking` to toggle the reasoning_content channel.
    const effort = resolveReasoningEffort(this.reasoningConfig);
    if (effort) {
      body.reasoning_effort = effort;
    }
    const thinkingBody = buildThinkingExtraBody(this.modelName, this.reasoningConfig);
    if (thinkingBody) {
      body.extra_body = thinkingBody;
    }
    return body;
  }

  private async chatNonStream(params: LLMChatParams): Promise<LLMChatResponse> {
    const body = this.buildBody(params, false);

    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.apiKey) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }

    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        `OpenAI chat completion failed: ${response.status} ${response.statusText} ${text}`,
        "openai",
        response.status,
      );
    }

    const data = (await response.json()) as OpenAIChatCompletion;
    const choice = data.choices[0];
    const message = choice?.message;
    const text = message?.content ?? "";
    const reasoning = message?.reasoning_content ?? message?.reasoning ?? "";
    const toolCalls = (message?.tool_calls ?? []).map(openAIToolCallToToolCall);
    const usage = buildUsage(data.usage);

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
      providerFinishReason: normalizeFinishReason(choice?.finish_reason),
      usage,
    };
  }

  private async chatStream(params: LLMChatParams): Promise<LLMChatResponse> {
    const body = this.buildBody(params, true);

    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.apiKey) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }

    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!response.ok || !response.body) {
      const text = response.body ? await response.text().catch(() => "") : "";
      throw new ProviderError(
        `OpenAI chat completion stream failed: ${response.status} ${response.statusText} ${text}`,
        "openai",
        response.status,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let textParts = "";
    let reasoningParts = "";
    let finishReason: string | undefined;
    const toolCallAgg: Map<number, OpenAIToolCall & { index: number }> = new Map();
    let usage: TokenUsage = { input: 0, output: 0, total: 0 };

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let payload = trimmed;
      if (payload.startsWith("data:")) payload = payload.slice(5).trim();
      if (payload === "[DONE]") return;
      let chunk: OpenAIChatStreamChunk;
      try {
        chunk = JSON.parse(payload) as OpenAIChatStreamChunk;
      } catch {
        return;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        const rc = delta.reasoning_content ?? delta.reasoning;
        if (typeof rc === "string" && rc) {
          reasoningParts += rc;
          params.onThinkDelta?.(rc);
        }
        const c = delta.content;
        if (typeof c === "string" && c) {
          textParts += c;
          params.onTextDelta?.(c);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const existing = toolCallAgg.get(idx) ?? {
              index: idx,
              id: "",
              type: "function",
              function: { name: "", arguments: "" },
            };
            if (tc.id) existing.id = tc.id;
            if (tc.type) existing.type = tc.type as "function";
            if (tc.function?.name) existing.function.name += tc.function.name;
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
            toolCallAgg.set(idx, existing);
          }
        }
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
      if (chunk.usage) {
        usage = buildUsage(chunk.usage);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        processLine(line);
      }
    }
    // Flush any trailing partial line.
    if (buffer.trim()) processLine(buffer);

    const toolCalls = [...toolCallAgg.values()]
      .sort((a, b) => a.index - b.index)
      .map(openAIToolCallToToolCall);

    return {
      text: textParts,
      reasoning: reasoningParts,
      toolCalls,
      providerFinishReason: normalizeFinishReason(finishReason),
      usage,
    };
  }
}

function buildUsage(raw: OpenAIChatCompletion["usage"]): TokenUsage {
  if (!raw) return { input: 0, output: 0, total: 0 };
  return {
    input: raw.prompt_tokens ?? 0,
    output: raw.completion_tokens ?? 0,
    total: raw.total_tokens ?? (raw.prompt_tokens ?? 0) + (raw.completion_tokens ?? 0),
    cacheRead: raw.prompt_cache_read_tokens,
    cacheWrite: raw.prompt_cache_write_tokens,
    reasoning: raw.completion_tokens_details?.reasoning_tokens,
  };
}

function toolToOpenAI(tool: Tool): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function openAIToolCallToToolCall(call: OpenAIToolCall): ToolCall {
  return {
    id: call.id,
    name: call.function.name,
    argumentsJson: call.function.arguments,
    arguments: parseJsonArguments(call.function.arguments),
  };
}

function parseJsonArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function buildOpenAIMessages(messages: Message[], systemPrompt?: string): unknown[] {
  const out: unknown[] = [];
  if (systemPrompt) {
    out.push({ role: "system", content: systemPrompt });
  }
  for (const message of messages) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content });
    } else if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      const assistant: Record<string, unknown> = { role: "assistant", content: message.content };
      // Replay reasoning_content on thinking models so strict OpenAI-compat
      // gateways don't 400 (kosong #1616). The field is only sent for
      // assistant turns that actually carry it.
      if (message.reasoningContent) {
        assistant.reasoning_content = message.reasoningContent;
      } else if (message.reasoning) {
        assistant.reasoning_content = message.reasoning;
      }
      if (message.toolCalls && message.toolCalls.length > 0) {
        assistant.tool_calls = message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          },
        }));
      }
      out.push(assistant);
    } else if (message.role === "tool") {
      out.push({
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      });
    }
  }
  return out;
}

function normalizeFinishReason(reason?: string): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "unknown";
  }
}

export function createOpenAIChatAdapter(
  model: string,
  apiKey?: string,
  baseUrl?: string,
): OpenAIChatAdapter {
  return new OpenAIChatAdapter({ model, apiKey, baseUrl });
}
