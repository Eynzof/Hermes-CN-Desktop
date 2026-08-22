/**
 * DingTalk platform adapter v1 surface.
 *
 * Live bot connections are stubbed behind start/stop lifecycle; tests use the
 * mocked adapter without real credentials.
 */

import { z } from "zod";
import type { PlatformAdapter, InboundMessageEvent, OutboundContent, SendMeta, SendResult, PlatformStatus } from "@hermes/gateway-core";

export const dingTalkConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appKey: z.string().optional(),
  webhookUrl: z.string().optional(),
  webhookSecret: z.string().optional(),
  allowedUsers: z.array(z.string()).optional(),
  commandPrefix: z.string().default("/"),
});
export type DingTalkConfig = z.infer<typeof dingTalkConfigSchema>;

export class DingTalkAdapter implements PlatformAdapter {
  status: PlatformStatus = "idle";
  private config: DingTalkConfig;
  private messageCounter = 0;

  readonly platform = "dingtalk";

  constructor(config: DingTalkConfig) {
    this.config = dingTalkConfigSchema.parse(config);
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) return;
    this.status = "connecting";
    // v1: stubbed; real SDK initialization goes here.
    this.status = "running";
  }

  async disconnect(): Promise<void> {
    this.status = "stopped";
  }

  async send(chatId: string, content: OutboundContent, meta?: SendMeta): Promise<SendResult> {
    this.messageCounter += 1;
    const text = content.type === "text" ? content.text : JSON.stringify(content.parts);
    return { ok: true, messageId: `dingtalk_${this.messageCounter}_${chatId}` };
  }

  async sendDocument(chatId: string, _path: string, _meta?: SendMeta): Promise<SendResult> {
    return { ok: true, messageId: `dingtalk_doc_${chatId}` };
  }

  async sendImageFile(chatId: string, _path: string, _meta?: SendMeta): Promise<SendResult> {
    return { ok: true, messageId: `dingtalk_img_${chatId}` };
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

  verifyWebhookSecret(payload: string, signature?: string): boolean {
    if (!this.config.webhookSecret) return true;
    // v1: constant-time compare placeholder.
    return signature === this.config.webhookSecret;
  }
}
