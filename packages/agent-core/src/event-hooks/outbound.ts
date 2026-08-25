/**
 * Outbound webhooks (signed lifecycle events).
 *
 * Mirrors Python `agent/outboundwebhooks.py`: lifecycle events (turn_start,
 * turn_complete, approval_requested, etc.) are POSTed to configured webhook
 * URLs; each payload is signed with HMAC-SHA256 (Web Crypto) so receivers can
 * verify authenticity. `signPayload` is exported for tests and parity checks.
 */

export interface OutboundWebhookConfig {
  id: string;
  url: string;
  /** Shared secret used to HMAC-sign payloads. */
  secret?: string;
  /** Lifecycle events this webhook receives. Empty = all events. */
  events?: string[];
  enabled?: boolean;
}

export interface OutboundWebhookDelivery {
  webhookId: string;
  ok: boolean;
  status?: number;
  error?: string;
}

const DEFAULT_EVENTS = [
  "turn_start",
  "turn_complete",
  "turn_error",
  "approval_requested",
  "session_created",
  "session_archived",
] as const;

export type LifecycleEvent = (typeof DEFAULT_EVENTS)[number];

export function isLifecycleEvent(value: unknown): value is LifecycleEvent {
  return typeof value === "string" && (DEFAULT_EVENTS as readonly string[]).includes(value);
}

/** HMAC-SHA256 signature of `body` using `secret` (hex). */
export async function signPayload(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface OutboundWebhookDispatcherOptions {
  fetchImpl?: typeof fetch;
}

export class OutboundWebhookDispatcher {
  private webhooks = new Map<string, OutboundWebhookConfig>();
  private readonly fetchImpl: typeof fetch;

  constructor(options: OutboundWebhookDispatcherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  register(config: OutboundWebhookConfig): void {
    this.webhooks.set(config.id, config);
  }

  unregister(id: string): boolean {
    return this.webhooks.delete(id);
  }

  list(): OutboundWebhookConfig[] {
    return Array.from(this.webhooks.values());
  }

  /** Deliver a lifecycle event to every matching webhook. */
  async dispatch(event: LifecycleEvent, payload: unknown): Promise<OutboundWebhookDelivery[]> {
    const body = JSON.stringify({ event, payload, sentAt: new Date().toISOString() });
    const deliveries: OutboundWebhookDelivery[] = [];
    for (const config of this.webhooks.values()) {
      if (config.enabled === false) continue;
      if (config.events && !config.events.includes(event)) continue;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.secret) {
        const signature = await signPayload(config.secret, body);
        headers["X-Hermes-Signature"] = `sha256=${signature}`;
      }
      try {
        const res = await this.fetchImpl(config.url, {
          method: "POST",
          headers,
          body,
        });
        deliveries.push({ webhookId: config.id, ok: res.ok, status: res.status });
      } catch (error) {
        deliveries.push({
          webhookId: config.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return deliveries;
  }
}
