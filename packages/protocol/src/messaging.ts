/**
 * Messaging gateway protocol schemas shared between Core, desktop gateway-core,
 * and messaging-platforms packages.
 */

import { z } from "zod";

export const messagingAdapterStatusSchema = z.enum(["idle", "connecting", "running", "error", "stopped"]);
export type MessagingAdapterStatus = z.infer<typeof messagingAdapterStatusSchema>;

export const platformConfigSchema = z.object({
  platform: z.string(),
  enabled: z.boolean().default(false),
  credentials: z.record(z.string()).default({}),
  webhookUrl: z.string().optional(),
  webhookSecret: z.string().optional(),
  allowedUsers: z.array(z.string()).default([]),
  commandPrefix: z.string().default("/"),
});
export type PlatformConfig = z.infer<typeof platformConfigSchema>;

export const messagingGatewayStatusSchema = z.object({
  running: z.boolean(),
  platforms: z.record(messagingAdapterStatusSchema),
  sessionCount: z.number().int(),
  pendingDeliveries: z.number().int(),
});
export type MessagingGatewayStatus = z.infer<typeof messagingGatewayStatusSchema>;

export const messagingPlatformListSchema = z.array(
  z.object({
    platform: z.string(),
    displayName: z.string(),
    enabled: z.boolean(),
    requiredEnv: z.array(z.string()),
  }),
);
export type MessagingPlatformList = z.infer<typeof messagingPlatformListSchema>;

export const messagingPlatforms = [
  { platform: "telegram", displayName: "Telegram", requiredEnv: ["TELEGRAM_BOT_TOKEN"] },
  { platform: "discord", displayName: "Discord", requiredEnv: ["DISCORD_BOT_TOKEN"] },
  { platform: "slack", displayName: "Slack", requiredEnv: ["SLACK_BOT_TOKEN"] },
  { platform: "whatsapp", displayName: "WhatsApp", requiredEnv: ["WHATSAPP_API_TOKEN"] },
  { platform: "signal", displayName: "Signal", requiredEnv: ["SIGNAL_ACCOUNT"] },
  { platform: "sms", displayName: "SMS (Twilio)", requiredEnv: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] },
  { platform: "email", displayName: "Email", requiredEnv: ["EMAIL_SMTP_HOST"] },
  { platform: "matrix", displayName: "Matrix", requiredEnv: ["MATRIX_ACCESS_TOKEN"] },
  { platform: "mattermost", displayName: "Mattermost", requiredEnv: ["MATTERMOST_TOKEN"] },
  { platform: "irc", displayName: "IRC", requiredEnv: ["IRC_SERVER"] },
  { platform: "line", displayName: "LINE", requiredEnv: ["LINE_CHANNEL_ACCESS_TOKEN"] },
  { platform: "dingtalk", displayName: "DingTalk", requiredEnv: ["DINGTALK_APP_KEY", "DINGTALK_APP_SECRET"] },
  { platform: "feishu", displayName: "Feishu / Lark", requiredEnv: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"] },
  { platform: "wecom", displayName: "WeCom", requiredEnv: ["WECOM_CORP_ID", "WECOM_SECRET"] },
] as const;
