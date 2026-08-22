/**
 * Google Chat platform adapter v1 surface.
 *
 * Live connections are stubbed behind start/stop lifecycle; tests use the
 * mocked adapter without real credentials. This mirrors the gateway-side
 * Python adapter; an in-process port would move the transport here.
 */

import { z } from "zod";
import type { PlatformAdapter, InboundMessageEvent, OutboundContent, SendMeta, SendResult, PlatformStatus } from "@hermes/gateway-core";

export const googleChatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  serviceAccountJson: z.string().optional(),
  projectId: z.string().optional(),
  subscriptionName: z.string().optional(),
  allowedUsers: z.array(z.string()).optional(),
  commandPrefix: z.string().default("/"),
});
export type GoogleChatConfig = z.infer<typeof googleChatConfigSchema>;

export class GoogleChatAdapter implements PlatformAdapter {
  status: PlatformStatus = "idle";
  private config: GoogleChatConfig;
  private messageCounter = 0;

  readonly platform = "google-chat";

  constructor(config: GoogleChatConfig) {
    this.config = googleChatConfigSchema.parse(config);
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) return;
    this.status = "connecting";
    // v1: stubbed; real SDK/transport initialization goes here.
    this.status = "running";
  }

  async disconnect(): Promise<void> {
    this.status = "stopped";
  }

  async send(chatId: string, content: OutboundContent, _meta?: SendMeta): Promise<SendResult> {
    this.messageCounter += 1;
    const text = content.type === "text" ? content.text : JSON.stringify(content.parts);
    return { ok: true, messageId: `google-chat_${this.messageCounter}_${chatId}` };
  }

  async sendDocument(chatId: string, _path: string, _meta?: SendMeta): Promise<SendResult> {
    return { ok: true, messageId: `google-chat_doc_${chatId}` };
  }

  async sendImageFile(chatId: string, _path: string, _meta?: SendMeta): Promise<SendResult> {
    return { ok: true, messageId: `google-chat_img_${chatId}` };
  }

  async sendTyping(_chatId: string): Promise<void> {
    // v1: no-op stub.
  }

  async editMessage(chatId: string, messageId: string, content: OutboundContent): Promise<SendResult> {
    const text = content.type === "text" ? content.text : JSON.stringify(content.parts);
    return { ok: true, messageId };
  }

  typedCommandPrefix(): string {
    return this.config.commandPrefix;
  }

  normalizeUpdate(_update: unknown): InboundMessageEvent | null {
    // v1: placeholder; real normalization parses platform-specific webhooks/updates.
    return null;
  }
}
