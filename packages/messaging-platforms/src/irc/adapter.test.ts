import { describe, it, expect } from "vitest";
import { IrcAdapter, ircConfigSchema } from "../irc/adapter.js";

describe("IrcAdapter", () => {
  const config = ircConfigSchema.parse({
    enabled: true,
    server: "test-value",
    webhookSecret: "shhh",
  });

  it("starts and stops without credentials", async () => {
    const adapter = new IrcAdapter(config);
    expect(adapter.platform).toBe("irc");
    await adapter.connect();
    expect(adapter.status).toBe("running");
    await adapter.disconnect();
    expect(adapter.status).toBe("stopped");
  });

  it("sends text messages", async () => {
    const adapter = new IrcAdapter(config);
    await adapter.connect();
    const res = await adapter.send("chat-1", { type: "text", text: "hello" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^irc_/);
  });

  it("edits messages", async () => {
    const adapter = new IrcAdapter(config);
    const res = await adapter.editMessage("chat-1", "m1", { type: "text", text: "updated" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("m1");
  });

  it("validates webhook secrets", () => {
    const adapter = new IrcAdapter(config);
    expect(adapter.verifyWebhookSecret("body", "shhh")).toBe(true);
    expect(adapter.verifyWebhookSecret("body", "wrong")).toBe(false);
  });

  it("skips connect when disabled", async () => {
    const disabled = ircConfigSchema.parse({ enabled: false });
    const adapter = new IrcAdapter(disabled);
    await adapter.connect();
    expect(adapter.status).toBe("idle");
  });
});
