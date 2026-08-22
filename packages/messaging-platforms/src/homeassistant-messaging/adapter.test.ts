import { describe, it, expect } from "vitest";
import { HomeassistantMessagingAdapter, homeassistantMessagingConfigSchema } from "../homeassistant-messaging/adapter.js";

describe("HomeassistantMessagingAdapter", () => {
  const config = homeassistantMessagingConfigSchema.parse({
    enabled: true,
  });

  it("starts and stops without credentials", async () => {
    const adapter = new HomeassistantMessagingAdapter(config);
    expect(adapter.platform).toBe("homeassistant-messaging");
    await adapter.connect();
    expect(adapter.status).toBe("running");
    await adapter.disconnect();
    expect(adapter.status).toBe("stopped");
  });

  it("sends text messages", async () => {
    const adapter = new HomeassistantMessagingAdapter(config);
    await adapter.connect();
    const res = await adapter.send("chat-1", { type: "text", text: "hello" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^homeassistant-messaging_/);
  });

  it("edits messages", async () => {
    const adapter = new HomeassistantMessagingAdapter(config);
    const res = await adapter.editMessage("chat-1", "m1", { type: "text", text: "updated" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("m1");
  });

  it("normalizes updates as placeholder", () => {
    const adapter = new HomeassistantMessagingAdapter(config);
    expect(adapter.normalizeUpdate({ id: "1" })).toBeNull();
  });

  it("skips connect when disabled", async () => {
    const disabled = homeassistantMessagingConfigSchema.parse({ enabled: false });
    const adapter = new HomeassistantMessagingAdapter(disabled);
    await adapter.connect();
    expect(adapter.status).toBe("idle");
  });
});
