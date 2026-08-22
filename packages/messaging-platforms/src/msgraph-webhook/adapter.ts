/**
 * MSGraph Webhook platform adapter v1 surface.
 *
 * Live connections are stubbed behind start/stop lifecycle; tests use the
 * mocked adapter without real credentials. This mirrors the gateway-side
 * Python adapter; an in-process port would move the transport here.
 */

import { z } from "zod";
import type { PlatformAdapter, InboundMessageEvent, OutboundContent, SendMeta, SendResult, PlatformStatus } from "@hermes/gateway-core";

export const msgraphWebhookConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().default(8646),
  clientState: z.string().optional(),
  webhookPath: z.string().default("/msgraph/webhook"),
  acceptedResources: z.array(z.string()).optional(),
  allowedSourceCidrs: z.array(z.string()).optional(),
  commandPrefix: z.string().default("/"),
});
export type MsgraphWebhookConfig = z.infer<typeof msgraphWebhookConfigSchema>;

export class MsgraphWebhookAdapter implements PlatformAdapter {
  status: PlatformStatus = "idle";
  private config: MsgraphWebhookConfig;
  private messageCounter = 0;

  readonly platform = "msgraph-webhook";

  constructor(config: MsgraphWebhookConfig) {
    this.config = msgraphWebhookConfigSchema.parse(config);
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
    return { ok: true, messageId: `msgraph-webhook_${this.messageCounter}_${chatId}` };
  }

  async sendDocument(chatId: string, _path: string, _meta?: SendMeta): Promise<SendResult> {
    return { ok: true, messageId: `msgraph-webhook_doc_${chatId}` };
  }

  async sendImageFile(chatId: string, _path: string, _meta?: SendMeta): Promise<SendResult> {
    return { ok: true, messageId: `msgraph-webhook_img_${chatId}` };
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
