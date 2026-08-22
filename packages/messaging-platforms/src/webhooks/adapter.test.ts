import { describe, it, expect } from "vitest";
import { WebhooksAdapter, webhooksConfigSchema } from "../webhooks/adapter.js";

describe("WebhooksAdapter", () => {
  const config = webhooksConfigSchema.parse({
    enabled: true,
  });

  it("starts and stops without credentials", async () => {
    const adapter = new WebhooksAdapter(config);
    expect(adapter.platform).toBe("webhooks");
    await adapter.connect();
    expect(adapter.status).toBe("running");
    await adapter.disconnect();
    expect(adapter.status).toBe("stopped");
  });

  it("sends text messages", async () => {
    const adapter = new WebhooksAdapter(config);
    await adapter.connect();
    const res = await adapter.send("chat-1", { type: "text", text: "hello" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^webhooks_/);
  });

  it("edits messages", async () => {
    const adapter = new WebhooksAdapter(config);
    const res = await adapter.editMessage("chat-1", "m1", { type: "text", text: "updated" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("m1");
  });

  it("normalizes updates as placeholder", () => {
    const adapter = new WebhooksAdapter(config);
    expect(adapter.normalizeUpdate({ id: "1" })).toBeNull();
  });

  it("skips connect when disabled", async () => {
    const disabled = webhooksConfigSchema.parse({ enabled: false });
    const adapter = new WebhooksAdapter(disabled);
    await adapter.connect();
    expect(adapter.status).toBe("idle");
  });
});
