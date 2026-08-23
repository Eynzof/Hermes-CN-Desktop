import { describe, expect, it } from "vitest";
import {
  messagingAdapterStatusSchema,
  messagingGatewayStatusSchema,
  messagingPlatformListSchema,
  messagingPlatforms,
  platformConfigSchema,
} from "./messaging";

describe("messagingAdapterStatusSchema", () => {
  it("accepts every status value", () => {
    for (const s of ["idle", "connecting", "running", "error", "stopped"]) {
      expect(messagingAdapterStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects unknown statuses", () => {
    expect(messagingAdapterStatusSchema.safeParse("paused").success).toBe(false);
  });
});

describe("platformConfigSchema", () => {
  it("applies defaults to a minimal config", () => {
    const parsed = platformConfigSchema.parse({ platform: "telegram" });
    expect(parsed).toEqual({
      platform: "telegram",
      enabled: false,
      credentials: {},
      allowedUsers: [],
      commandPrefix: "/",
    });
  });

  it("parses a full platform config", () => {
    const parsed = platformConfigSchema.parse({
      platform: "slack",
      enabled: true,
      credentials: { token: "xoxb-1" },
      webhookUrl: "https://hooks.slack.com/AAA",
      webhookSecret: "sec",
      allowedUsers: ["u1"],
      commandPrefix: "!",
    });
    expect(parsed.webhookUrl).toBe("https://hooks.slack.com/AAA");
    expect(parsed.commandPrefix).toBe("!");
    expect(parsed.credentials).toEqual({ token: "xoxb-1" });
  });

  it("rejects a missing platform and a non-array allowedUsers", () => {
    expect(platformConfigSchema.safeParse({}).success).toBe(false);
    expect(
      platformConfigSchema.safeParse({ platform: "x", allowedUsers: "u1" }).success,
    ).toBe(false);
  });
});

describe("messagingGatewayStatusSchema", () => {
  it("parses a gateway status", () => {
    const parsed = messagingGatewayStatusSchema.parse({
      running: true,
      platforms: { telegram: "running", slack: "idle" },
      sessionCount: 3,
      pendingDeliveries: 1,
    });
    expect(parsed.platforms.telegram).toBe("running");
    expect(parsed.sessionCount).toBe(3);
  });

  it("rejects non-integer counts and invalid platform statuses", () => {
    expect(
      messagingGatewayStatusSchema.safeParse({
        running: true,
        platforms: {},
        sessionCount: 3.5,
        pendingDeliveries: 0,
      }).success,
    ).toBe(false);
    expect(
      messagingGatewayStatusSchema.safeParse({
        running: true,
        platforms: { tg: "bogus" },
        sessionCount: 1,
        pendingDeliveries: 0,
      }).success,
    ).toBe(false);
  });
});

describe("messagingPlatformListSchema", () => {
  it("parses the platform list shape", () => {
    const parsed = messagingPlatformListSchema.parse([
      { platform: "telegram", displayName: "Telegram", enabled: true, requiredEnv: ["TELEGRAM_BOT_TOKEN"] },
    ]);
    expect(parsed[0]?.platform).toBe("telegram");
  });

  it("rejects entries missing requiredEnv", () => {
    const result = messagingPlatformListSchema.safeParse([
      { platform: "x", displayName: "X", enabled: false },
    ]);
    expect(result.success).toBe(false);
  });
});

describe("messagingPlatforms", () => {
  it("lists 14 platforms with unique names and non-empty env requirements", () => {
    expect(messagingPlatforms.length).toBe(14);
    const names = messagingPlatforms.map((p) => p.platform);
    expect(new Set(names).size).toBe(names.length);
    for (const p of messagingPlatforms) {
      expect(p.displayName.length).toBeGreaterThan(0);
      expect(p.requiredEnv.length).toBeGreaterThan(0);
    }
  });

  it("starts with telegram and includes the CN platforms", () => {
    expect(messagingPlatforms[0]?.platform).toBe("telegram");
    const platforms = messagingPlatforms.map((p) => p.platform);
    expect(platforms).toEqual(
      expect.arrayContaining(["dingtalk", "feishu", "wecom", "line", "mattermost"]),
    );
  });
});
