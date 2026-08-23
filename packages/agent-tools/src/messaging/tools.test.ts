import { describe, expect, it } from "vitest";
import {
  messagingConfigure,
  messagingStatus,
  messagingStart,
  messagingStop,
  messagingSend,
} from "./tools.js";

const PLATFORM_COUNT = 29;

describe("messagingConfigure", () => {
  it("returns the normalized config for a known platform", async () => {
    const res = await messagingConfigure({ platform: "telegram", enabled: true, credentials: { token: "abc" } });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content);
    expect(parsed.platform).toBe("telegram");
    expect(parsed.enabled).toBe(true);
    expect(parsed.credentials).toEqual(["token"]);
  });

  it("accepts platforms without credentials", async () => {
    const res = await messagingConfigure({ platform: "slack", enabled: false });
    const parsed = JSON.parse(res.content);
    expect(parsed.credentials).toEqual([]);
  });

  it("rejects unknown platforms with an error result", async () => {
    const res = await messagingConfigure({ platform: "nope", enabled: true });
    expect(res.isError).toBe(true);
    expect(res.content).toBe("Unknown platform: nope");
  });

  it("rejects missing platform arguments", async () => {
    const res = await messagingConfigure(undefined);
    expect(res.isError).toBe(true);
    expect(res.content).toBe("Unknown platform: undefined");
  });
});

describe("messagingStatus", () => {
  it("reports an idle gateway and all platforms when unscoped", async () => {
    const res = await messagingStatus({});
    const parsed = JSON.parse(res.content);
    expect(parsed.gateway).toBe("idle");
    expect(Object.keys(parsed.platforms)).toHaveLength(PLATFORM_COUNT);
    for (const status of Object.values(parsed.platforms as Record<string, string>)) {
      expect(status).toBe("idle");
    }
  });

  it("accepts a scoped platform", async () => {
    const res = await messagingStatus({ platform: "discord" });
    const parsed = JSON.parse(res.content);
    expect(parsed.platforms.discord).toBe("idle");
  });

  it("rejects unknown platforms", async () => {
    const res = await messagingStatus({ platform: "bogus" });
    expect(res.isError).toBe(true);
    expect(res.content).toBe("Unknown platform: bogus");
  });
});

describe("messagingStart / messagingStop", () => {
  it("starts the whole gateway by default", async () => {
    const res = await messagingStart({});
    const parsed = JSON.parse(res.content);
    expect(parsed.started).toBe("gateway");
    expect(parsed.liveConnection).toBe(false);
  });

  it("starts a specific platform", async () => {
    const res = await messagingStart({ platform: "whatsapp" });
    expect(JSON.parse(res.content).started).toBe("whatsapp");
  });

  it("stops the whole gateway by default", async () => {
    const res = await messagingStop({});
    expect(JSON.parse(res.content).stopped).toBe("gateway");
  });

  it("stops a specific platform", async () => {
    const res = await messagingStop({ platform: "line" });
    expect(JSON.parse(res.content).stopped).toBe("line");
  });
});

describe("messagingSend", () => {
  it("returns a stub message id prefixed with the platform", async () => {
    const res = await messagingSend({ platform: "telegram", chatId: "chat-1", text: "hello" });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content);
    expect(parsed.platform).toBe("telegram");
    expect(parsed.chatId).toBe("chat-1");
    expect(parsed.text).toBe("hello");
    expect(parsed.messageId).toMatch(/^telegram_stub_\d+$/);
  });
});
