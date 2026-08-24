import { describe, it, expect } from "vitest";
import { TelegramAdapter, telegramConfigSchema } from "../telegram/adapter.js";

describe("TelegramAdapter", () => {
  const config = telegramConfigSchema.parse({
    enabled: true,
    botToken: "test-value",
    webhookSecret: "shhh",
  });

  it("starts and stops without credentials", async () => {
    const adapter = new TelegramAdapter(config);
    expect(adapter.platform).toBe("telegram");
    await adapter.connect();
    expect(adapter.status).toBe("running");
    await adapter.disconnect();
    expect(adapter.status).toBe("stopped");
  });

  it("sends text messages", async () => {
    const adapter = new TelegramAdapter(config);
    await adapter.connect();
    const res = await adapter.send("chat-1", { type: "text", text: "hello" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^telegram_/);
  });

  it("edits messages", async () => {
    const adapter = new TelegramAdapter(config);
    const res = await adapter.editMessage("chat-1", "m1", { type: "text", text: "updated" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("m1");
  });

  it("validates webhook secrets", () => {
    const adapter = new TelegramAdapter(config);
    expect(adapter.verifyWebhookSecret("body", "shhh")).toBe(true);
    expect(adapter.verifyWebhookSecret("body", "wrong")).toBe(false);
    // Same-length and length-mismatch rejections must all go through the
    // constant-time compare (no early-exit on length differences).
    expect(adapter.verifyWebhookSecret("body", "shhi")).toBe(false);
    expect(adapter.verifyWebhookSecret("body", "wrong-secret-value")).toBe(false);
    expect(adapter.verifyWebhookSecret("body", "sh")).toBe(false);
  });

  it("short-circuits when the webhook secret is unset", () => {
    const noSecret = telegramConfigSchema.parse({ enabled: true });
    const adapter = new TelegramAdapter(noSecret);
    expect(adapter.verifyWebhookSecret("body", "anything")).toBe(true);
    expect(adapter.verifyWebhookSecret("body", undefined)).toBe(true);
  });

  it("skips connect when disabled", async () => {
    const disabled = telegramConfigSchema.parse({ enabled: false });
    const adapter = new TelegramAdapter(disabled);
    await adapter.connect();
    expect(adapter.status).toBe("idle");
  });
});
