import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus, type GatewayEvent } from "./event-bus.js";

function sampleEvents(): GatewayEvent[] {
  return [
    { type: "session.start", sessionId: "s1" },
    { type: "typing", platform: "telegram", chatId: "c1" },
    { type: "outbound", platform: "telegram", chatId: "c1", content: "hi" },
    { type: "error", platform: "telegram", error: "boom" },
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EventBus", () => {
  it("delivers events to all subscribers", () => {
    const bus = new EventBus();
    const seen: GatewayEvent[] = [];
    const unsub1 = bus.onDidPublish((ev) => seen.push(ev));
    const unsub2 = bus.onDidPublish((ev) => seen.push(ev));
    const event: GatewayEvent = { type: "session.start", sessionId: "s1" };
    bus.publish(event);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(event);
    unsub1();
    unsub2();
  });

  it("unsubscribe stops further delivery", () => {
    const bus = new EventBus();
    const seen: GatewayEvent[] = [];
    const unsub = bus.onDidPublish((ev) => seen.push(ev));
    unsub();
    bus.publish({ type: "session.start", sessionId: "s1" });
    expect(seen).toHaveLength(0);
  });

  it("is idempotent for duplicate unsubscribe calls", () => {
    const bus = new EventBus();
    const seen: GatewayEvent[] = [];
    const unsub = bus.onDidPublish((ev) => seen.push(ev));
    unsub();
    unsub();
    bus.publish({ type: "session.start", sessionId: "s1" });
    expect(seen).toHaveLength(0);
    expect(bus.listenerCount()).toBe(0);
  });

  it("tracks listener count", () => {
    const bus = new EventBus();
    expect(bus.listenerCount()).toBe(0);
    const a = bus.onDidPublish(() => {});
    const b = bus.onDidPublish(() => {});
    expect(bus.listenerCount()).toBe(2);
    a();
    expect(bus.listenerCount()).toBe(1);
    b();
    expect(bus.listenerCount()).toBe(0);
  });

  it("a throwing listener never blocks peers and is logged", () => {
    const bus = new EventBus();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const good: GatewayEvent[] = [];
    bus.onDidPublish(() => {
      throw new Error("listener blew up");
    });
    bus.onDidPublish((ev) => good.push(ev));

    const event: GatewayEvent = { type: "typing", platform: "tg", chatId: "c" };
    bus.publish(event);
    expect(good).toEqual([event]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("routes every gateway event variant", () => {
    const bus = new EventBus();
    const types: string[] = [];
    bus.onDidPublish((ev) => types.push(ev.type));
    for (const ev of sampleEvents()) {
      bus.publish(ev);
    }
    expect(types).toEqual(["session.start", "typing", "outbound", "error"]);
  });

  it("fires events in publish order for a single listener", () => {
    const bus = new EventBus();
    const sessionIds: string[] = [];
    bus.onDidPublish((ev) => {
      if (ev.type === "session.start") sessionIds.push(ev.sessionId);
    });
    bus.publish({ type: "session.start", sessionId: "a" });
    bus.publish({ type: "session.start", sessionId: "b" });
    expect(sessionIds).toEqual(["a", "b"]);
  });
});
