import { ProviderError } from "../errors.js";
import type {
  LLM,
  LLMChatParams,
  LLMChatResponse,
  Message,
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
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChatCompletion {
  choices: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_read_tokens?: number;
    prompt_cache_write_tokens?: number;
  };
}

export class OpenAIChatAdapter implements LLM {
  readonly modelName: string;
  readonly systemPrompt?: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIChatAdapterOptions) {
    this.modelName = options.model;
    this.systemPrompt = options.systemPrompt;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(params: LLMChatParams): Promise<LLMChatResponse> {
    const messages = buildOpenAIMessages(params.messages, this.systemPrompt);
    const tools = params.tools.length > 0 ? params.tools.map(toolToOpenAI) : undefined;

    const body: Record<string, unknown> = {
      model: this.modelName,
      messages,
      stream: false,
    };
    if (tools) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const headers = new Headers({
      "Content-Type": "application/json",
    });
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
    const toolCalls = (message?.tool_calls ?? []).map(openAIToolCallToToolCall);
    const usage = data.usage
      ? {
          input: data.usage.prompt_tokens ?? 0,
          output: data.usage.completion_tokens ?? 0,
          total: data.usage.total_tokens ?? 0,
          cacheRead: data.usage.prompt_cache_read_tokens,
          cacheWrite: data.usage.prompt_cache_write_tokens,
        }
      : { input: 0, output: 0, total: 0 };

    if (text) {
      params.onTextDelta?.(text);
    }

    return {
      text,
      toolCalls,
      providerFinishReason: normalizeFinishReason(choice?.finish_reason),
      usage,
    };
  }
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
