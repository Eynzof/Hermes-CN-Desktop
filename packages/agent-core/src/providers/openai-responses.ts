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

export interface OpenAIResponsesAdapterOptions {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
  /**
   * Per-adapter reasoning configuration. When enabled, the adapter sends
   * `reasoning: { effort, summary: "auto" }` so the Responses endpoint
   * emits a `reasoning` output item alongside the `message` output item.
   */
  reasoningConfig?: ReasoningConfig;
}

/** Responses API output item: reasoning (chain-of-thought). */
interface ResponsesReasoningItem {
  type: "reasoning";
  id?: string;
  content?: Array<{ type: string; text?: string | null }>;
  summary?: Array<{ type: string; text?: string | null }>;
  encrypted_content?: string;
}

/** Responses API output item: message (visible text). */
interface ResponsesMessageItem {
  type: "message";
  id?: string;
  content?: Array<{ type: string; text?: string | null; annotations?: unknown[] }>;
  status?: string;
}

/** Responses API output item: function_call. */
interface ResponsesFunctionCallItem {
  type: "function_call";
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

type ResponsesOutputItem =
  | ResponsesReasoningItem
  | ResponsesMessageItem
  | ResponsesFunctionCallItem;

interface ResponsesApiResult {
  id?: string;
  status?: string;
  model?: string;
  output?: ResponsesOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  incomplete_details?: { reason?: string } | null;
}

function resolveReasoningEffort(
  reasoningConfig?: ReasoningConfig,
): "low" | "medium" | "high" | null {
  if (!reasoningConfig) return null;
  if (reasoningConfig.disabled) return null;
  if (reasoningConfig.enabled === false) return null;
  const effort = reasoningConfig.effort;
  if (!effort) return "medium";
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  return "medium";
}

function buildUsage(raw: ResponsesApiResult["usage"]): TokenUsage {
  if (!raw) return { input: 0, output: 0, total: 0 };
  return {
    input: raw.input_tokens ?? 0,
    output: raw.output_tokens ?? 0,
    total: raw.total_tokens ?? (raw.input_tokens ?? 0) + (raw.output_tokens ?? 0),
    cacheRead: raw.input_tokens_details?.cached_tokens,
    reasoning: raw.output_tokens_details?.reasoning_tokens,
  };
}

/**
 * Convert Hermes messages to Responses API `input` items.
 *
 * The Responses API takes `input` as a list of role-bearing items whose
 * content is typed (`input_text` for user, `output_text` for assistant).
 */
function buildResponsesInput(messages: Message[]): unknown[] {
  const input: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      // System is sent via the top-level `instructions` field, not input.
      continue;
    }
    if (msg.role === "user") {
      input.push({
        role: "user",
        content: [{ type: "input_text", text: msg.content }],
      });
    } else if (msg.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (msg.reasoningContent || msg.reasoning) {
        // Replay a reasoning item so the endpoint keeps cross-turn coherence.
        content.push({ type: "reasoning_text", text: msg.reasoningContent ?? msg.reasoning });
      }
      content.push({ type: "output_text", text: msg.content });
      input.push({ role: "assistant", content });
    } else if (msg.role === "tool") {
      // Tool results become function_call_output items.
      input.push({
        type: "function_call_output",
        call_id: msg.toolCallId,
        output: msg.content,
      });
    }
  }
  return input;
}

function buildResponsesTools(tools: readonly Tool[]): unknown[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export class OpenAIResponsesAdapter implements LLM {
  readonly modelName: string;
  readonly systemPrompt?: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly reasoningConfig?: ReasoningConfig;

  constructor(options: OpenAIResponsesAdapterOptions) {
    this.modelName = options.model;
    this.systemPrompt = options.systemPrompt;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.reasoningConfig = options.reasoningConfig;
  }

  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    const instructions = this.systemPrompt ?? extractSystemPrompt(params.messages);
    const input = buildResponsesInput(params.messages);
    const responseTools = buildResponsesTools(params.tools);

    const body: Record<string, unknown> = {
      model: this.modelName,
      input,
      store: false,
    };
    if (instructions) {
      body.instructions = instructions;
    }
    if (responseTools) {
      body.tools = responseTools;
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }

    const effort = resolveReasoningEffort(this.reasoningConfig);
    if (effort) {
      body.reasoning = { effort, summary: "auto" };
    }

    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.apiKey) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }

    const response = await this.fetchImpl(`${this.baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        `OpenAI Responses request failed: ${response.status} ${response.statusText} ${text}`,
        "openai-responses",
        response.status,
      );
    }

    const data = (await response.json()) as ResponsesApiResult;
    const outputItems = data.output ?? [];

    let text = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];

    for (const item of outputItems) {
      if (item.type === "reasoning") {
        const parts: string[] = [];
        for (const c of item.content ?? []) {
          if ((c.type === "reasoning_text" || c.type === "text") && typeof c.text === "string") {
            parts.push(c.text);
          }
        }
        reasoning += parts.join("");
      } else if (item.type === "message") {
        for (const c of item.content ?? []) {
          if ((c.type === "output_text" || c.type === "text") && typeof c.text === "string") {
            text += c.text;
          }
        }
      } else if (item.type === "function_call") {
        const fc = item as ResponsesFunctionCallItem;
        toolCalls.push({
          id: fc.call_id ?? fc.id ?? "",
          name: fc.name ?? "",
          arguments: parseJsonArguments(fc.arguments ?? "{}"),
          argumentsJson: fc.arguments ?? "{}",
        });
      }
    }

    if (reasoning) {
      params.onThinkDelta?.(reasoning);
    }
    if (text) {
      params.onTextDelta?.(text);
    }

    const usage = buildUsage(data.usage);

    // Status incomplete with content_filter → content_filter finish reason.
    let finishReason: FinishReason = "stop";
    if (data.status === "incomplete") {
      const reason = data.incomplete_details?.reason;
      if (reason === "content_filter") {
        finishReason = "content_filter";
      } else {
        finishReason = "length";
      }
    } else if (toolCalls.length > 0) {
      finishReason = "tool_calls";
    }

    return {
      text,
      reasoning,
      toolCalls,
      providerFinishReason: finishReason,
      usage,
    };
  }
}

function extractSystemPrompt(messages: Message[]): string | undefined {
  for (const m of messages) {
    if (m.role === "system" && m.content) return m.content;
  }
  return undefined;
}

function parseJsonArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function createOpenAIResponsesAdapter(
  model: string,
  apiKey?: string,
  baseUrl?: string,
): OpenAIResponsesAdapter {
  return new OpenAIResponsesAdapter({ model, apiKey, baseUrl });
}
