import { describe, it, expect } from "vitest";
import { QqbotAdapter, qqbotConfigSchema } from "../qqbot/adapter.js";

describe("QqbotAdapter", () => {
  const config = qqbotConfigSchema.parse({
    enabled: true,
  });

  it("starts and stops without credentials", async () => {
    const adapter = new QqbotAdapter(config);
    expect(adapter.platform).toBe("qqbot");
    await adapter.connect();
    expect(adapter.status).toBe("running");
    await adapter.disconnect();
    expect(adapter.status).toBe("stopped");
  });

  it("sends text messages", async () => {
    const adapter = new QqbotAdapter(config);
    await adapter.connect();
    const res = await adapter.send("chat-1", { type: "text", text: "hello" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toMatch(/^qqbot_/);
  });

  it("edits messages", async () => {
    const adapter = new QqbotAdapter(config);
    const res = await adapter.editMessage("chat-1", "m1", { type: "text", text: "updated" });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe("m1");
  });

  it("normalizes updates as placeholder", () => {
    const adapter = new QqbotAdapter(config);
    expect(adapter.normalizeUpdate({ id: "1" })).toBeNull();
  });

  it("skips connect when disabled", async () => {
    const disabled = qqbotConfigSchema.parse({ enabled: false });
    const adapter = new QqbotAdapter(disabled);
    await adapter.connect();
    expect(adapter.status).toBe("idle");
  });
});
