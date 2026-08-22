import { describe, it, expect } from "vitest";
import { WhatsAppAdapter, whatsAppConfigSchema } from "../whatsapp/adapter.js";

describe("WhatsAppAdapter", () => {
  const config = whatsAppConfigSchema.parse({
    enabled: true,
    apiToken: "test-value",
    webhookSecret: "shhh",
  });

  it("starts and stops without credentials", async () => {
    const adapter = new WhatsAppAdapter(config);
    expect(adapter.platform).toBe("whatsapp");
    await adapter.connect();
    expect(adapter.status).toBe("running");
    await adapter.disconnect();
    expect(adapter.status).toBe("stopped");
  });

  it("sends text messages", async () => {
    const adapter = new WhatsAppAdapter(config);
    await adapter.connect();
    const res = await adapter.send("chat-1", { type: "text", text: "hello" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^whatsapp_/);
  });

  it("edits messages", async () => {
    const adapter = new WhatsAppAdapter(config);
    const res = await adapter.editMessage("chat-1", "m1", { type: "text", text: "updated" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("m1");
  });

  it("validates webhook secrets", () => {
    const adapter = new WhatsAppAdapter(config);
    expect(adapter.verifyWebhookSecret("body", "shhh")).toBe(true);
    expect(adapter.verifyWebhookSecret("body", "wrong")).toBe(false);
  });

  it("skips connect when disabled", async () => {
    const disabled = whatsAppConfigSchema.parse({ enabled: false });
    const adapter = new WhatsAppAdapter(disabled);
    await adapter.connect();
    expect(adapter.status).toBe("idle");
  });
});
