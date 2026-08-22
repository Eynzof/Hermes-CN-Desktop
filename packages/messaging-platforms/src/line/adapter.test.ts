import { describe, it, expect } from "vitest";
import { LineAdapter, lineConfigSchema } from "../line/adapter.js";

describe("LineAdapter", () => {
  const config = lineConfigSchema.parse({
    enabled: true,
    channelAccessToken: "test-value",
    webhookSecret: "shhh",
  });

  it("starts and stops without credentials", async () => {
    const adapter = new LineAdapter(config);
    expect(adapter.platform).toBe("line");
    await adapter.connect();
    expect(adapter.status).toBe("running");
    await adapter.disconnect();
    expect(adapter.status).toBe("stopped");
  });

  it("sends text messages", async () => {
    const adapter = new LineAdapter(config);
    await adapter.connect();
    const res = await adapter.send("chat-1", { type: "text", text: "hello" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^line_/);
  });

  it("edits messages", async () => {
    const adapter = new LineAdapter(config);
    const res = await adapter.editMessage("chat-1", "m1", { type: "text", text: "updated" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("m1");
  });

  it("validates webhook secrets", () => {
    const adapter = new LineAdapter(config);
    expect(adapter.verifyWebhookSecret("body", "shhh")).toBe(true);
    expect(adapter.verifyWebhookSecret("body", "wrong")).toBe(false);
  });

  it("skips connect when disabled", async () => {
    const disabled = lineConfigSchema.parse({ enabled: false });
    const adapter = new LineAdapter(disabled);
    await adapter.connect();
    expect(adapter.status).toBe("idle");
  });
});
