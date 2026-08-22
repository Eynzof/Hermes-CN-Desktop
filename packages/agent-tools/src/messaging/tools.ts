/**
 * Messaging platform tool handlers (v1 stubs).
 *
 * Live bot connections stay in the managed Core runtime for v1. These tools
 * expose configuration/status surfaces and route to the gateway core.
 */

import type { ToolResult } from "../types.js";

export interface MessagingToolContext {
  sessionId?: string;
  env?: Record<string, string | undefined>;
}

function ok(content: unknown): ToolResult {
  return { content: typeof content === "string" ? content : JSON.stringify(content, null, 2) };
}

function err(message: string): ToolResult {
  return { content: message, isError: true };
}

const PLATFORMS = [
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "signal",
  "sms",
  "email",
  "matrix",
  "mattermost",
  "irc",
  "line",
  "dingtalk",
  "feishu",
  "wecom",
  "weixin",
  "qqbot",
  "yuanbao",
  "teams",
  "bluebubbles",
  "photon",
  "ntfy",
  "raft",
  "simplex",
  "google-chat",
  "homeassistant-messaging",
  "webhooks",
  "hermes-relay",
  "buzz-nostr",
  "msgraph-webhook",
] as const;

export async function messagingConfigure(args: unknown, _ctx?: MessagingToolContext): Promise<ToolResult> {
  const { platform, enabled, credentials = {} } = args as {
    platform: string;
    enabled: boolean;
    credentials?: Record<string, string>;
  };
  if (!PLATFORMS.includes(platform as (typeof PLATFORMS)[number])) {
    return err(`Unknown platform: ${platform}`);
  }
  return ok({ platform, enabled, credentials: Object.keys(credentials) });
}

export async function messagingStatus(args: unknown, _ctx?: MessagingToolContext): Promise<ToolResult> {
  const { platform } = args as { platform?: string };
  if (platform && !PLATFORMS.includes(platform as (typeof PLATFORMS)[number])) {
    return err(`Unknown platform: ${platform}`);
  }
  return ok({
    gateway: "idle",
    platforms: PLATFORMS.reduce(
      (acc, p) => {
        acc[p] = platform && p !== platform ? "idle" : "idle";
        return acc;
      },
      {} as Record<string, string>,
    ),
  });
}

export async function messagingStart(args: unknown, _ctx?: MessagingToolContext): Promise<ToolResult> {
  const { platform } = args as { platform?: string };
  return ok({ started: platform ?? "gateway", liveConnection: false });
}

export async function messagingStop(args: unknown, _ctx?: MessagingToolContext): Promise<ToolResult> {
  const { platform } = args as { platform?: string };
  return ok({ stopped: platform ?? "gateway" });
}

export async function messagingSend(args: unknown, _ctx?: MessagingToolContext): Promise<ToolResult> {
  const { platform, chatId, text } = args as { platform: string; chatId: string; text: string };
  return ok({ platform, chatId, text, messageId: `${platform}_stub_${Date.now()}` });
}
