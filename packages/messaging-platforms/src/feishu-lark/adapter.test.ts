import { describe, it, expect } from "vitest";
import { FeishuLarkAdapter, feishuLarkConfigSchema } from "../feishu-lark/adapter.js";

describe("FeishuLarkAdapter", () => {
  const config = feishuLarkConfigSchema.parse({
    enabled: true,
    appId: "test-value",
    webhookSecret: "shhh",
  });

  it("starts and stops without credentials", async () => {
    const adapter = new FeishuLarkAdapter(config);
    expect(adapter.platform).toBe("feishu");
    await adapter.connect();
    expect(adapter.status).toBe("running");
    await adapter.disconnect();
    expect(adapter.status).toBe("stopped");
  });

  it("sends text messages", async () => {
    const adapter = new FeishuLarkAdapter(config);
    await adapter.connect();
    const res = await adapter.send("chat-1", { type: "text", text: "hello" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^feishu_/);
  });

  it("edits messages", async () => {
    const adapter = new FeishuLarkAdapter(config);
    const res = await adapter.editMessage("chat-1", "m1", { type: "text", text: "updated" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("m1");
  });

  it("validates webhook secrets", () => {
    const adapter = new FeishuLarkAdapter(config);
    expect(adapter.verifyWebhookSecret("body", "shhh")).toBe(true);
    expect(adapter.verifyWebhookSecret("body", "wrong")).toBe(false);
  });

  it("skips connect when disabled", async () => {
    const disabled = feishuLarkConfigSchema.parse({ enabled: false });
    const adapter = new FeishuLarkAdapter(disabled);
    await adapter.connect();
    expect(adapter.status).toBe("idle");
  });
});
