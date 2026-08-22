/**
 * Platform adapter contract for messaging gateways.
 *
 * Mirrors the Python `gateway/platforms/base.py` ABC in TypeScript.
 * v1 adapters are stubbed: `connect`/`disconnect` manage lifecycle without
 * requiring real credentials in tests.
 */

import { z } from "zod";

export const platformStatusSchema = z.enum(["idle", "connecting", "running", "error", "stopped"]);
export type PlatformStatus = z.infer<typeof platformStatusSchema>;

export const messagePartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), url: z.string().optional(), path: z.string().optional(), mime: z.string().optional() }),
  z.object({ type: z.literal("voice"), path: z.string(), mime: z.string().optional(), durationMs: z.number().optional() }),
]);
export type MessagePart = z.infer<typeof messagePartSchema>;

export const inboundMessageEventSchema = z.object({
  id: z.string(),
  platform: z.string(),
  chatId: z.string(),
  chatType: z.enum(["dm", "group", "channel", "thread"]),
  userId: z.string(),
  username: z.string().optional(),
  threadId: z.string().optional(),
  scopeId: z.string().optional(),
  parts: z.array(messagePartSchema),
  raw: z.record(z.unknown()).optional(),
  receivedAt: z.number(),
});
export type InboundMessageEvent = z.infer<typeof inboundMessageEventSchema>;

export const sendResultSchema = z.object({
  ok: z.boolean(),
  messageId: z.string().optional(),
  error: z.string().optional(),
});
export type SendResult = z.infer<typeof sendResultSchema>;

export const sendMetaSchema = z.object({
  replyTo: z.string().optional(),
  threadId: z.string().optional(),
  silent: z.boolean().optional(),
});
export type SendMeta = z.infer<typeof sendMetaSchema>;

export const outboundContentSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("parts"), parts: z.array(messagePartSchema) }),
]);
export type OutboundContent = z.infer<typeof outboundContentSchema>;

export interface PlatformAdapter {
  readonly platform: string;
  readonly status: PlatformStatus;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(chatId: string, content: OutboundContent, meta?: SendMeta): Promise<SendResult>;
  sendDocument(chatId: string, path: string, meta?: SendMeta): Promise<SendResult>;
  sendImageFile(chatId: string, path: string, meta?: SendMeta): Promise<SendResult>;
  sendTyping(chatId: string): Promise<void>;
  editMessage(chatId: string, messageId: string, content: OutboundContent): Promise<SendResult>;
  typedCommandPrefix(): string;
}
