/**
 * Messaging platform tool registration.
 *
 * Registers platform_config, platform_status, platform_start, platform_stop,
 * and platform_send tools for each supported messaging gateway adapter.
 */

import { z } from "zod";
import { registry } from "../registry.js";
import { objectSchema } from "../catalog.js";
import type { ToolEntry } from "../types.js";
import { messagingConfigure, messagingStatus, messagingStart, messagingStop, messagingSend } from "./tools.js";

export function registerMessagingTools(): void {
  const platformEnum = z.enum([
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
  ]);

  const tools: ToolEntry[] = [
    {
      name: "messaging_configure",
      toolset: "messaging",
      description: "Configure a messaging platform adapter (enable, credentials, webhook).",
      emoji: "🛜",
      tags: ["messaging"],
      schema: objectSchema({
        platform: platformEnum.describe("Messaging platform to configure"),
        enabled: z.boolean().describe("Whether the adapter is enabled"),
        credentials: z.record(z.string()).optional().describe("Credential map for the platform"),
        webhookUrl: z.string().optional().describe("Webhook URL if used"),
        webhookSecret: z.string().optional().describe("Shared secret for webhook verification"),
      }),
      handler: messagingConfigure,
    },
    {
      name: "messaging_status",
      toolset: "messaging",
      description: "Get the gateway and per-platform adapter status.",
      emoji: "📶",
      tags: ["messaging"],
      schema: objectSchema({
        platform: z.string().optional().describe("Optional platform to scope status to"),
      }),
      handler: messagingStatus,
    },
    {
      name: "messaging_start",
      toolset: "messaging",
      description: "Start the gateway or a specific platform adapter.",
      emoji: "▶️",
      tags: ["messaging"],
      schema: objectSchema({
        platform: z.string().optional().describe("Platform to start; omit for whole gateway"),
      }),
      handler: messagingStart,
    },
    {
      name: "messaging_stop",
      toolset: "messaging",
      description: "Stop the gateway or a specific platform adapter.",
      emoji: "⏹️",
      tags: ["messaging"],
      schema: objectSchema({
        platform: z.string().optional().describe("Platform to stop; omit for whole gateway"),
      }),
      handler: messagingStop,
    },
    {
      name: "messaging_send",
      toolset: "messaging",
      description: "Send a message through a platform adapter.",
      emoji: "📨",
      tags: ["messaging"],
      schema: objectSchema({
        platform: platformEnum.describe("Target messaging platform"),
        chatId: z.string().describe("Destination chat id"),
        text: z.string().describe("Message text"),
      }),
      handler: messagingSend,
    },
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
}

registerMessagingTools();
