/**
 * Durable at-least-once delivery ledger parity with Python gateway/delivery*.py.
 *
 * v1 is in-memory only; the Rust-side SQLite durability layer is stubbed but
 * the schema and lifecycle hooks are present.
 */

import { z } from "zod";

export const deliveryStateSchema = z.enum(["pending", "sending", "delivered", "failed"]);
export type DeliveryState = z.infer<typeof deliveryStateSchema>;

export const deliveryRowSchema = z.object({
  rowId: z.string(),
  sessionId: z.string(),
  platform: z.string(),
  chatId: z.string(),
  payload: z.string(),
  state: deliveryStateSchema,
  attempts: z.number().int().min(0),
  createdAt: z.number(),
  dedupeKey: z.string().optional(),
});
export type DeliveryRow = z.infer<typeof deliveryRowSchema>;

export interface OutboundPayload {
  text: string;
  mediaPath?: string;
  explicitMedia?: boolean;
}

export class DeliveryLedger {
  private rows = new Map<string, DeliveryRow>();
  private attemptsMax = 3;
  private freshnessMs = 24 * 3600_000;

  begin(sessionId: string, platform: string, chatId: string, payload: OutboundPayload): DeliveryRow {
    const rowId = `dl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const dedupeKey = payload.mediaPath && !payload.explicitMedia ? payload.mediaPath : undefined;
    const row: DeliveryRow = {
      rowId,
      sessionId,
      platform,
      chatId,
      payload: JSON.stringify(payload),
      state: "pending",
      attempts: 0,
      createdAt: Date.now(),
      dedupeKey,
    };
    this.rows.set(rowId, row);
    return row;
  }

  ack(rowId: string): void {
    const row = this.rows.get(rowId);
    if (!row) return;
    row.state = "delivered";
  }

  fail(rowId: string, error?: string): void {
    const row = this.rows.get(rowId);
    if (!row) return;
    row.attempts += 1;
    if (row.attempts >= this.attemptsMax || Date.now() - row.createdAt > this.freshnessMs) {
      row.state = "failed";
    }
  }

  redeliverOnBoot(now = Date.now()): DeliveryRow[] {
    const stale: DeliveryRow[] = [];
    for (const row of this.rows.values()) {
      if (row.state === "pending" || row.state === "sending") {
        if (now - row.createdAt <= this.freshnessMs && row.attempts < this.attemptsMax) {
          const payload = JSON.parse(row.payload) as OutboundPayload;
          if (!payload.text.startsWith("\u267b\ufe0f ")) {
            payload.text = `\u267b\ufe0f Recovered reply\n${payload.text}`;
            row.payload = JSON.stringify(payload);
          }
          row.state = "pending";
          stale.push(row);
        } else {
          row.state = "failed";
        }
      }
    }
    return stale;
  }

  dedupeMedia(sessionId: string, path: string, explicit: boolean): boolean {
    if (explicit) return false;
    for (const row of this.rows.values()) {
      if (row.sessionId === sessionId && row.dedupeKey === path && row.state === "delivered") {
        return true;
      }
    }
    return false;
  }

  listForSession(sessionId: string): DeliveryRow[] {
    return [...this.rows.values()].filter((r) => r.sessionId === sessionId);
  }
}
