import { describe, expect, it } from "vitest";
import { registerMessagingTools } from "./catalog.js";
import { registry } from "../registry.js";

const TOOL_NAMES = ["messaging_configure", "messaging_status", "messaging_start", "messaging_stop", "messaging_send"];

describe("messaging catalog registration", () => {
  it("registers the five messaging tools under the messaging toolset", () => {
    for (const name of TOOL_NAMES) {
      const entry = registry.get(name);
      expect(entry, `expected ${name}`).toBeDefined();
      expect(entry!.toolset).toBe("messaging");
      expect(entry!.handler).toBeTypeOf("function");
    }
  });

  it("messaging_configure schema enumerates supported platforms", () => {
    const schema = registry.get("messaging_configure")!.schema;
    const platform = schema.properties?.platform as { enum?: string[] } | undefined;
    const platforms = platform?.enum ?? [];
    for (const p of ["telegram", "discord", "slack", "mattermost", "homeassistant-messaging", "webhooks", "msgraph-webhook"]) {
      expect(platforms).toContain(p);
    }
    expect(platforms.length).toBeGreaterThanOrEqual(20);
  });

  it("messaging_send requires platform, chatId and text", () => {
    const schema = registry.get("messaging_send")!.schema;
    expect(schema.required).toEqual(["platform", "chatId", "text"]);
  });
});

describe("messaging tool dispatch through the registry", () => {
  it("dispatches messaging_send successfully", async () => {
    const res = await registry.dispatch(
      "messaging_send",
      { platform: "slack", chatId: "C123", text: "hi" },
      {},
    );
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content);
    expect(parsed.messageId).toMatch(/^slack_stub_\d+$/);
  });

  it("dispatches messaging_configure with an unknown platform as an error", async () => {
    const res = await registry.dispatch("messaging_configure", { platform: "carrier-pigeon", enabled: true }, {});
    expect(res.isError).toBe(true);
    expect(res.content).toBe("Unknown platform: carrier-pigeon");
  });

  it("dispatches messaging_status with a known platform", async () => {
    const res = await registry.dispatch("messaging_status", { platform: "feishu" }, {});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content).gateway).toBe("idle");
  });
});

describe("registerMessagingTools", () => {
  it("is exported and re-registers the five messaging tools", () => {
    expect(registerMessagingTools).toBeTypeOf("function");
    registerMessagingTools();
    for (const name of TOOL_NAMES) {
      expect(registry.get(name)).toBeDefined();
    }
  });
});
