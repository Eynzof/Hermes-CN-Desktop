import { describe, it, expect } from "vitest";
import { DingTalkAdapter, dingTalkConfigSchema } from "../dingtalk/adapter.js";

describe("DingTalkAdapter", () => {
  const config = dingTalkConfigSchema.parse({
    enabled: true,
    appKey: "test-value",
    webhookSecret: "shhh",
  });

  it("starts and stops without credentials", async () => {
    const adapter = new DingTalkAdapter(config);
    expect(adapter.platform).toBe("dingtalk");
    await adapter.connect();
    expect(adapter.status).toBe("running");
    await adapter.disconnect();
    expect(adapter.status).toBe("stopped");
  });

  it("sends text messages", async () => {
    const adapter = new DingTalkAdapter(config);
    await adapter.connect();
    const res = await adapter.send("chat-1", { type: "text", text: "hello" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^dingtalk_/);
  });

  it("edits messages", async () => {
    const adapter = new DingTalkAdapter(config);
    const res = await adapter.editMessage("chat-1", "m1", { type: "text", text: "updated" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("m1");
  });

  it("validates webhook secrets", () => {
    const adapter = new DingTalkAdapter(config);
    expect(adapter.verifyWebhookSecret("body", "shhh")).toBe(true);
    expect(adapter.verifyWebhookSecret("body", "wrong")).toBe(false);
    // Same-length and length-mismatch rejections must all go through the
    // constant-time compare (no early-exit on length differences).
    expect(adapter.verifyWebhookSecret("body", "shhi")).toBe(false);
    expect(adapter.verifyWebhookSecret("body", "wrong-secret-value")).toBe(false);
    expect(adapter.verifyWebhookSecret("body", "sh")).toBe(false);
  });

  it("short-circuits when the webhook secret is unset", () => {
    const noSecret = dingTalkConfigSchema.parse({ enabled: true });
    const adapter = new DingTalkAdapter(noSecret);
    expect(adapter.verifyWebhookSecret("body", "anything")).toBe(true);
    expect(adapter.verifyWebhookSecret("body", undefined)).toBe(true);
  });

  it("skips connect when disabled", async () => {
    const disabled = dingTalkConfigSchema.parse({ enabled: false });
    const adapter = new DingTalkAdapter(disabled);
    await adapter.connect();
    expect(adapter.status).toBe("idle");
  });
});
