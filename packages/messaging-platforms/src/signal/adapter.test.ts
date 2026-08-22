import { describe, it, expect } from "vitest";
import { SignalAdapter, signalConfigSchema } from "../signal/adapter.js";

describe("SignalAdapter", () => {
  const config = signalConfigSchema.parse({
    enabled: true,
    account: "test-value",
    webhookSecret: "shhh",
  });

  it("starts and stops without credentials", async () => {
    const adapter = new SignalAdapter(config);
    expect(adapter.platform).toBe("signal");
    await adapter.connect();
    expect(adapter.status).toBe("running");
    await adapter.disconnect();
    expect(adapter.status).toBe("stopped");
  });

  it("sends text messages", async () => {
    const adapter = new SignalAdapter(config);
    await adapter.connect();
    const res = await adapter.send("chat-1", { type: "text", text: "hello" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^signal_/);
  });

  it("edits messages", async () => {
    const adapter = new SignalAdapter(config);
    const res = await adapter.editMessage("chat-1", "m1", { type: "text", text: "updated" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("m1");
  });

  it("validates webhook secrets", () => {
    const adapter = new SignalAdapter(config);
    expect(adapter.verifyWebhookSecret("body", "shhh")).toBe(true);
    expect(adapter.verifyWebhookSecret("body", "wrong")).toBe(false);
  });

  it("skips connect when disabled", async () => {
    const disabled = signalConfigSchema.parse({ enabled: false });
    const adapter = new SignalAdapter(disabled);
    await adapter.connect();
    expect(adapter.status).toBe("idle");
  });
});
