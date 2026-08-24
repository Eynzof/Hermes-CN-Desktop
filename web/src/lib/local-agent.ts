import type { SessionStore } from "./session-store/session-store";
import { getLocalSessionStore } from "./session-store/local-store";
import { readUiValue } from "./ui-store";
import { resolveModelMaxTokens } from "./model-defaults";

export interface LocalTurnEvent {
  type: string;
  session_id?: string;
  payload?: Record<string, unknown>;
}

export interface LocalTurnRequest {
  sessionId: string;
  text: string;
  images?: string[];
  emit: (ev: LocalTurnEvent) => void;
  now?: number;
}

export type LocalTurnHandler = (req: LocalTurnRequest) => Promise<string | undefined>;

let handler: LocalTurnHandler | null = null;

export function setLocalTurnHandler(h: LocalTurnHandler | null): void {
  handler = h;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the local config + env stores and build the OpenAI-compatible
 * chat-completions request parameters. Returns null when no provider is
 * configured or no API key is available — caller falls back to echo mode.
 */
function resolveLocalModelConfig(): {
  baseUrl: string;
  apiKey: string;
  model: string;
  contextLength?: number;
} | null {
  const config = readUiValue<Record<string, unknown>>("hermes.active-config", {});
  const model = isRecord(config.model) ? config.model : {};
  const envVars = readUiValue<Record<string, string>>("hermes.env-vars", {});

  // Resolve the API key: model.api_key > env var named by the provider's
  // apiKeyLabel > any *_API_KEY in env vars. This matches the config shape
  // written by buildProviderConfigUpdate / buildCurrentModelConfigUpdate.
  const providerId = typeof model.provider === "string" ? model.provider : "";
  const apiKeyFromConfig = typeof model.api_key === "string" ? model.api_key : "";

  // The provider catalog stores the canonical env-var name (e.g.
  // "DEEPSEEK_API_KEY") in the provider entry's apiKeyLabel. But the local
  // config just stores provider id + api_key directly, so prefer the config
  // key and fall back to scanning env vars for a matching *_API_KEY.
  let apiKey = apiKeyFromConfig;
  if (!apiKey) {
    const upperProvider = providerId.toUpperCase().replace(/-/g, "_");
    apiKey = envVars[`${upperProvider}_API_KEY`] ?? "";
  }
  if (!apiKey) {
    // Last resort: any *_API_KEY that is set
    for (const [key, value] of Object.entries(envVars)) {
      if (key.endsWith("_API_KEY") && value) {
        apiKey = value;
        break;
      }
    }
  }

  const baseUrl = typeof model.base_url === "string" ? model.base_url : "";
  const modelName = typeof model.default === "string" ? model.default : "";

  if (!baseUrl || !apiKey || !modelName) return null;
  const contextLength =
    typeof config.model_context_length === "number" && Number.isFinite(config.model_context_length)
      ? config.model_context_length
      : undefined;
  return { baseUrl, apiKey, model: modelName, contextLength };
}

/**
 * Call an OpenAI-compatible /v1/chat/completions endpoint (non-streaming) and
 * return the assistant reply text. Uses a simple fetch — the in-process
 * gateway transport is not a streaming HTTP client, so we buffer the full
 * reply and then emit it in chunks via the normal message.delta path.
 *
 * `messages` must carry the full conversation (previous user + assistant turns
 * plus the current user message). Sending only the current message makes every
 * follow-up a stateless prompt: real reasoning models can then legitimately
 * answer with `content: null` (reasoning-only), which surfaced as the
 * "model returned empty reply" bug on the second turn of a resumed session.
 */
async function callRemoteModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  maxTokens: number,
): Promise<string> {
  // Construct the chat completions URL. Most OpenAI-compatible APIs follow
  // the pattern <base_url>/chat/completions (when base_url already includes
  // /v1, e.g. "https://api.openai.com/v1") or <base_url>/v1/chat/completions
  // (when base_url is just the origin path, e.g. "https://api.kimi.com/coding").
  // We detect which form to use by checking if the base_url already ends with
  // /v1 or includes it as a path segment.
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const chatPath = /\/v1(\/|$)/.test(normalizedBase) ? "/chat/completions" : "/v1/chat/completions";
  const url = normalizedBase + chatPath;

  // In browser mode, direct cross-origin fetch to the LLM API is blocked by
  // CORS (the API doesn't send Access-Control-Allow-Origin). Route the
  // request through the Vite dev server proxy at /__llm_proxy, which
  // forwards to the real URL with changeOrigin. In Tauri mode (no CORS),
  // call the URL directly.
  const isBrowser = typeof window !== "undefined" && window.location.protocol.startsWith("http");
  const fetchUrl = isBrowser ? `/__llm_proxy?target=${encodeURIComponent(url)}` : url;

  const res = await fetch(fetchUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      // Derive the output-token budget from the model name (kimi-agent's
      // `_resolve_model_defaults` semantics), falling back to
      // configured context_length // 4 and finally a conservative default.
      // A hard-coded 1024 was small enough that a reasoning-heavy follow-up
      // could exhaust the budget and come back with empty `content`.
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
      };
    }>;
  };
  const message = data.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  // Reasoning models (DeepSeek Reasoner, Kimi thinking, OpenAI o-series, ...)
  // put the chain of thought in `reasoning_content` and can leave `content`
  // empty when the budget runs out. Surface the reasoning instead of failing
  // the whole turn with "model returned empty reply".
  const reasoning =
    typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  const reply = content || reasoning;
  if (!reply) {
    throw new Error("model returned empty reply");
  }
  return reply;
}

async function defaultReply(req: LocalTurnRequest): Promise<string | undefined> {
  // Try to call the real model configured in the local config store.
  const cfg = resolveLocalModelConfig();
  if (cfg) {
    // streamLocalTurn already appended the current user message before the
    // handler runs, so the stored history IS the full conversation: previous
    // user/assistant turns + this message. Handing it to the model lets the
    // "next talk" of a resumed session actually continue the conversation
    // instead of arriving as a context-free single prompt.
    const store = getLocalSessionStore();
    const history = await store.getMessages(req.sessionId);
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    for (const m of history) {
      if (
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length > 0
      ) {
        messages.push({ role: m.role, content: m.content });
      }
    }
    if (messages.length === 0) {
      messages.push({ role: "user", content: req.text });
    }
    const maxTokens = resolveModelMaxTokens(cfg.model, cfg.contextLength);
    return callRemoteModel(cfg.baseUrl, cfg.apiKey, cfg.model, messages, maxTokens);
  }
  // Fall back to echo mode when no provider is configured.
  const img = req.images?.length ? `\n[已附带 ${req.images.length} 张图片]` : "";
  return `[本地引擎·回声模式]\n\n${req.text}${img}`;
}

function splitChunks(text: string, size = 24): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Standalone conversation engine: persists the exchange into the local
 * SessionStore and emits the same GatewayEvent stream the official backend
 * would (message.start / message.delta / message.complete / status.update).
 */
export async function streamLocalTurn(req: LocalTurnRequest): Promise<void> {
  const store = getLocalSessionStore();
  const { sessionId, text, emit, now = Date.now() } = req;

  emit({ type: "status.update", session_id: sessionId, payload: { kind: "provider_wait", text: "本地引擎处理中…" } });
  await store.appendMessages(sessionId, [
    { role: "user", content: text, timestamp: Math.floor(now / 1000) },
  ]);

  emit({ type: "message.start", session_id: sessionId, payload: {} });

  let reply: string | undefined;
  try {
    reply = await (handler ?? defaultReply)(req);
  } catch (err) {
    emit({
      type: "error",
      session_id: sessionId,
      payload: { message: err instanceof Error ? err.message : String(err) },
    });
    return;
  }

  const finalText = reply ?? "";
  for (const chunk of splitChunks(finalText)) {
    await sleep(12);
    emit({ type: "message.delta", session_id: sessionId, payload: { text: chunk } });
  }

  emit({
    type: "message.complete",
    session_id: sessionId,
    payload: { text: finalText, status: "complete" },
  });
  await store.appendMessages(sessionId, [
    { role: "assistant", content: finalText, timestamp: Math.floor(Date.now() / 1000) },
  ]);
  emit({ type: "status.update", session_id: sessionId, payload: { kind: "complete", text: "" } });
}