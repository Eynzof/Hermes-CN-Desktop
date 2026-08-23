/**
 * In-process gateway transport for standalone (no-backend) mode.
 *
 * `gateway-client.ts` speaks the official /api/ws JSON-RPC protocol through a
 * WebSocket-shaped surface (send / onmessage / readyState). This transports
 * dispatches those frames to local handlers instead of a socket, so the chat
 * store, session lifecycle, usage polling and model-options UI keep working
 * unchanged when run.py boots the web app with no Python backend.
 *
 * Frame shapes (identical to the real gateway):
 *   response: { jsonrpc, id, result } | { jsonrpc, id, error }
 *   event:    { method: "event", params: { type, session_id, payload } }
 */
import type { GatewayTransport } from "./gateway-transport";
import { getLocalSessionStore } from "./session-store/local-store";
import { streamLocalTurn, type LocalTurnEvent } from "./local-agent";

export const LOCAL_MODEL_CATALOG = [
  { slug: "openai", name: "OpenAI", models: ["gpt-4o", "gpt-4o-min"] },
  { slug: "anthropic", name: "Anthropic", models: ["claude-sonnet-4", "claude-haiku-4"] },
  { slug: "gemini", name: "Google Gemini", models: ["gemini-2.0-flash", "gemini-1.5-pro"] },
  { slug: "deepseek", name: "DeepSeek", models: ["deepseek-chat", "deepseek-reasoner"] },
  { slug: "moonshot", name: "Moonshot (Kimi)", models: ["moonshot-v1-8k", "moonshot-v1-32k"] },
  { slug: "qwen", name: "Qwen", models: ["qwen-plus", "qwen-max"] },
];

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class GatewayInProcessTransport implements GatewayTransport {
  readyState = 0;
  onopen: GatewayTransport["onopen"] = null;
  onclose: GatewayTransport["onclose"] = null;
  onerror: GatewayTransport["onerror"] = null;
  onmessage: GatewayTransport["onmessage"] = null;

  constructor() {
    // Defer into a macrotask so gateway-client's connect() assigns onopen
    // before the synthetic open fires.
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    }, 0);
  }

  private store = getLocalSessionStore();

  send(data: string): void {
    let frame: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!frame || typeof frame.method !== "string") return;
    const params = frame.params ?? {};

    if (frame.id == null) {
      void this.dispatch(frame.method, params).catch(() => {});
      return;
    }

    Promise.resolve(this.dispatch(frame.method, params)).then(
      (result) => this.emit({ jsonrpc: "2.0", id: frame!.id, result }),
      (err: unknown) =>
        this.emit({
          jsonrpc: "2.0",
          id: frame!.id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        }),
    );
  }

  private emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  private notify(event: LocalTurnEvent): void {
    this.emit({ method: "event", params: { type: event.type, session_id: event.session_id, payload: event.payload } });
  }

  private async dispatch(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "session.create": {
        const s = await this.store.create({ title: str(p.title), cwd: str(p.cwd), model: str(p.model) });
        return { session_id: s.id, stored_session_id: null, message_count: s.message_count };
      }
      case "session.resume": {
        const s = await this.store.get(str(p.session_id));
        return s ? { session_id: s.id, resumed: s.id, message_count: s.message_count } : { session_id: str(p.session_id) };
      }
      case "session.close": {
        await this.store.delete(str(p.session_id));
        return { ok: true };
      }
      case "session.title": {
        await this.store.setTitle(str(p.session_id), str(p.title));
        return { session_key: str(p.session_id) };
      }
      case "session.usage":
        return { model: "local-echo", input: 0, output: 0, total: 0, calls: 0 };
      case "prompt.submit": {
        const sessionId = str(p.session_id);
        const text = str(p.text);
        const images = Array.isArray(p.images) ? p.images.filter((x) => typeof x === "string") : undefined;
        void streamLocalTurn({
          sessionId,
          text,
          images: images as string[] | undefined,
          emit: (ev) => this.notify(ev),
        }).catch(() => {});
        return { accepted: true };
      }
      case "model.options":
        return { providers: LOCAL_MODEL_CATALOG };
      case "provider.probe":
        return { ok: true, latency_ms: 0, model_count: 0, sample_models: [], status_code: null, error: null, error_kind: null };
      case "provider.models":
        return { ok: true, models: [], model_count: 0, status_code: null, error: null, error_kind: null };
      case "config.set":
        return { key: str(p.key), value: str(p.value) };
      case "complete.slash":
      case "complete.path":
        return { items: [] };
      case "command.dispatch":
        return { type: str(p.type), message: str(p.message) };
      case "approval.respond":
        return { ok: true };
      case "session.interrupt":
        return { ok: true };
      default:
        throw new Error(`method not implemented: ${method}`);
    }
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "local close" } as CloseEvent);
  }
}

/** Test helper: slice of GatewayTransport used by consumers. */
export type LocalGatewayEvent = LocalTurnEvent;