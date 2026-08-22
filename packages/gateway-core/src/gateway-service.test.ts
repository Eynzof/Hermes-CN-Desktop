import { describe, it, expect, vi, beforeEach } from "vitest";
import { GatewayService } from "./gateway-service.js";
import type { InboundMessageEvent, PlatformAdapter, OutboundContent, SendMeta, SendResult } from "./adapter.js";

class MockAdapter implements PlatformAdapter {
  status: import("./adapter.js").PlatformStatus = "idle";
  connects = 0;
  disconnects = 0;
  sent: { chatId: string; content: OutboundContent; meta?: SendMeta }[] = [];

  constructor(readonly platform: string) {}

  async connect(): Promise<void> {
    this.connects++;
    this.status = "running";
  }

  async disconnect(): Promise<void> {
    this.disconnects++;
    this.status = "stopped";
  }

  async send(chatId: string, content: OutboundContent, meta?: SendMeta): Promise<SendResult> {
    this.sent.push({ chatId, content, meta });
    return { ok: true, messageId: `msg_${this.sent.length}` };
  }

  async sendDocument(chatId: string): Promise<SendResult> {
    return { ok: true, messageId: `doc_${chatId}` };
  }

  async sendImageFile(chatId: string): Promise<SendResult> {
    return { ok: true, messageId: `img_${chatId}` };
  }

  async sendTyping(): Promise<void> {}

  async editMessage(chatId: string, messageId: string, content: OutboundContent): Promise<SendResult> {
    return { ok: true, messageId };
  }

  typedCommandPrefix(): string {
    return "/";
  }
}

function makeEvent(platform: string, text: string, userId = "u1", chatId = "c1"): InboundMessageEvent {
  return {
    id: `ev_${platform}_${chatId}`,
    platform,
    chatId,
    chatType: "dm",
    userId,
    parts: [{ type: "text", text }],
    receivedAt: Date.now(),
  };
}

describe("GatewayService", () => {
  let service: GatewayService;

  beforeEach(() => {
    service = new GatewayService();
  });

  it("registers adapters and lists platforms", () => {
    service.registerAdapter(new MockAdapter("telegram"));
    service.registerAdapter(new MockAdapter("discord"));
    expect(service.listPlatforms()).toEqual(["discord", "telegram"]);
  });

  it("starts and stops adapters", async () => {
    const telegram = new MockAdapter("telegram");
    service.registerAdapter(telegram);
    await service.start();
    expect(service.isRunning()).toBe(true);
    expect(telegram.connects).toBe(1);
    await service.stop();
    expect(service.isRunning()).toBe(false);
    expect(telegram.disconnects).toBe(1);
  });

  it("routes slash commands to adapters", async () => {
    const telegram = new MockAdapter("telegram");
    service.registerAdapter(telegram);
    await service.start();
    service.receive(makeEvent("telegram", "/status"));
    await new Promise((r) => setTimeout(r, 10));
    expect(telegram.sent.length).toBe(1);
    expect(telegram.sent[0].content).toEqual({ type: "text", text: "Status for telegram: ok" });
  });

  it("publishes inbound events on the bus", () => {
    const listener = vi.fn();
    service.bus.onDidPublish(listener);
    const ev = makeEvent("telegram", "hello");
    service.receive(ev);
    expect(listener).toHaveBeenCalledWith({ type: "inbound", event: ev });
  });

  it("redelivers pending rows on boot with recovered prefix", () => {
    service.ledger.begin("s1", "telegram", "c1", { text: "hello" });
    const rows = service.ledger.redeliverOnBoot();
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0].payload) as { text: string };
    expect(parsed.text).toContain("Recovered reply");
  });

  it("evicts idle sessions on tick", () => {
    const store = service.store;
    store.ensure({ platform: "telegram", chatId: "c1", chatType: "dm", userId: "u1" });
    expect(store.evictIdleSessions(Date.now() + 3700_000)).toBe(1);
  });
});
