/**
 * Gateway service parity with Python gateway/run.py.
 *
 * v1 wires the event bus, session multiplexer, slash dispatcher, delivery ledger,
 * and a registry of platform adapters. Live bot connections are stubbed; tests
 * use mocked adapters.
 */

import { EventBus } from "./event-bus.js";
import { SessionMultiplexer, SessionStore } from "./session.js";
import { SlashDispatcher } from "./slash.js";
import { DeliveryLedger } from "./delivery.js";
import type { PlatformAdapter, InboundMessageEvent } from "./adapter.js";

export interface GatewayServiceOptions {
  busyMode?: "queue" | "interrupt" | "steer";
  isAdmin?: (event: InboundMessageEvent) => boolean;
}

export class GatewayService {
  readonly bus = new EventBus();
  readonly store = new SessionStore();
  readonly ledger = new DeliveryLedger();
  readonly multiplexer: SessionMultiplexer;
  readonly slash = new SlashDispatcher();
  private adapters = new Map<string, PlatformAdapter>();
  private running = false;
  private tickTimer?: ReturnType<typeof setInterval>;

  constructor(private opts: GatewayServiceOptions = {}) {
    this.multiplexer = new SessionMultiplexer(this.store, {
      busyMode: opts.busyMode,
      isAdmin: opts.isAdmin,
    });
  }

  registerAdapter(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  getAdapter(platform: string): PlatformAdapter | undefined {
    return this.adapters.get(platform);
  }

  listPlatforms(): string[] {
    return [...this.adapters.keys()].sort();
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    for (const adapter of this.adapters.values()) {
      await adapter.connect().catch((err) => {
        this.bus.publish({ type: "error", platform: adapter.platform, error: String(err) });
      });
    }
    this.ledger.redeliverOnBoot();
    this.tickTimer = setInterval(() => this.tick(), 60_000);
  }

  async stop(opts: { drainTimeoutMs: number } = { drainTimeoutMs: 10_000 }): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    const deadline = Date.now() + opts.drainTimeoutMs;
    for (const adapter of this.adapters.values()) {
      if (Date.now() >= deadline) break;
      await adapter.disconnect().catch(() => {});
    }
    await this.shutdownFlush();
  }

  async restart(opts: { afterTurnTimeoutMs: number } = { afterTurnTimeoutMs: 30_000 }): Promise<void> {
    await this.stop({ drainTimeoutMs: opts.afterTurnTimeoutMs });
    await this.start();
  }

  async shutdownFlush(): Promise<void> {
    // v1: in-memory ledger has no transcript spool to flush.
  }

  private tick(): void {
    this.store.evictIdleSessions();
  }

  receive(event: InboundMessageEvent): void {
    this.bus.publish({ type: "inbound", event });
    const decision = this.multiplexer.route(event);
    if (decision.action === "slash") {
      this.slash
        .dispatch({
          platform: event.platform,
          chatId: event.chatId,
          userId: event.userId,
          command: decision.command,
          args: decision.args,
          isAdmin: this.opts.isAdmin?.(event) ?? false,
        })
        .then((text) => {
          const adapter = this.adapters.get(event.platform);
          if (adapter) {
            adapter
              .send(event.chatId, { type: "text", text })
              .then((res) => {
                if (res.ok) this.ledger.ack(res.messageId ?? "");
              })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }
  }
}
