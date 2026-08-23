import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryLedger, deliveryRowSchema, deliveryStateSchema } from "./delivery.js";

const SESSION = "sess_1";
const PLATFORM = "telegram";
const CHAT = "c1";

afterEach(() => {
  vi.useRealTimers();
});

describe("deliveryStateSchema / deliveryRowSchema", () => {
  it("accepts every delivery state", () => {
    for (const s of ["pending", "sending", "delivered", "failed"]) {
      expect(deliveryStateSchema.parse(s)).toBe(s);
    }
    expect(deliveryStateSchema.safeParse("queued").success).toBe(false);
  });

  it("validates row shapes", () => {
    const row = {
      rowId: "dl_1",
      sessionId: SESSION,
      platform: PLATFORM,
      chatId: CHAT,
      payload: "{}",
      state: "pending" as const,
      attempts: 0,
      createdAt: 1,
    };
    expect(deliveryRowSchema.parse(row).state).toBe("pending");
    expect(deliveryRowSchema.parse({ ...row, dedupeKey: "/tmp/a.png" }).dedupeKey).toBe("/tmp/a.png");
    expect(deliveryRowSchema.safeParse({ ...row, attempts: -1 }).success).toBe(false);
    expect(deliveryRowSchema.safeParse({ ...row, attempts: 1.5 }).success).toBe(false);
    expect(deliveryRowSchema.safeParse({ ...row, state: "nope" }).success).toBe(false);
  });
});

describe("DeliveryLedger.begin", () => {
  it("creates a pending row with a unique id and JSON payload", () => {
    const ledger = new DeliveryLedger();
    const row = ledger.begin(SESSION, PLATFORM, CHAT, { text: "hi" });
    expect(row.state).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.rowId.startsWith("dl_")).toBe(true);
    expect(JSON.parse(row.payload)).toEqual({ text: "hi" });
    expect(row.dedupeKey).toBeUndefined();
  });

  it("derives a dedupe key only for non-explicit media paths", () => {
    const ledger = new DeliveryLedger();
    const bare = ledger.begin(SESSION, PLATFORM, CHAT, { text: "pic", mediaPath: "/tmp/a.png" });
    expect(bare.dedupeKey).toBe("/tmp/a.png");

    const explicit = ledger.begin(SESSION, PLATFORM, CHAT, {
      text: "pic",
      mediaPath: "/tmp/b.png",
      explicitMedia: true,
    });
    expect(explicit.dedupeKey).toBeUndefined();
  });

  it("generates distinct row ids per begin", () => {
    const ledger = new DeliveryLedger();
    const a = ledger.begin(SESSION, PLATFORM, CHAT, { text: "1" });
    const b = ledger.begin(SESSION, PLATFORM, CHAT, { text: "2" });
    expect(a.rowId).not.toBe(b.rowId);
  });
});

describe("DeliveryLedger.ack / fail", () => {
  it("ack marks a row delivered", () => {
    const ledger = new DeliveryLedger();
    const row = ledger.begin(SESSION, PLATFORM, CHAT, { text: "hi" });
    ledger.ack(row.rowId);
    expect(ledger.listForSession(SESSION)[0]?.state).toBe("delivered");
  });

  it("ack on an unknown row is a no-op", () => {
    const ledger = new DeliveryLedger();
    expect(() => ledger.ack("dl_missing")).not.toThrow();
  });

  it("fail increments attempts and fails after the max attempts", () => {
    const ledger = new DeliveryLedger();
    const row = ledger.begin(SESSION, PLATFORM, CHAT, { text: "hi" });
    ledger.fail(row.rowId);
    ledger.fail(row.rowId);
    expect(ledger.listForSession(SESSION)[0]?.state).toBe("pending");
    expect(ledger.listForSession(SESSION)[0]?.attempts).toBe(2);
    ledger.fail(row.rowId);
    expect(ledger.listForSession(SESSION)[0]?.state).toBe("failed");
    expect(ledger.listForSession(SESSION)[0]?.attempts).toBe(3);
  });

  it("fail on an unknown row is a no-op", () => {
    const ledger = new DeliveryLedger();
    expect(() => ledger.fail("dl_missing")).not.toThrow();
  });
});

describe("DeliveryLedger.redeliverOnBoot", () => {
  it("recovers pending/sending rows with the ♻️ prefix and resets state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const ledger = new DeliveryLedger();
    const pending = ledger.begin(SESSION, PLATFORM, CHAT, { text: "lost" });
    const sending = ledger.begin(SESSION, PLATFORM, CHAT, { text: "mid-send" });
    ledger.ack(ledger.begin(SESSION, PLATFORM, CHAT, { text: "done" }).rowId);

    const stale = ledger.redeliverOnBoot(1_000_000 + 60_000);
    expect(stale.map((r) => r.rowId).sort()).toEqual([pending.rowId, sending.rowId].sort());
    for (const row of stale) {
      expect(row.state).toBe("pending");
      const payload = JSON.parse(row.payload) as { text: string };
      expect(payload.text).toMatch(/^♻️ Recovered reply\n/);
    }
    // Delivered rows stay delivered.
    const rows = ledger.listForSession(SESSION);
    expect(rows.find((r) => r.state === "delivered")?.payload).not.toMatch(/♻️/);
  });

  it("does not double-prefix rows already recovered", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const ledger = new DeliveryLedger();
    const row = ledger.begin(SESSION, PLATFORM, CHAT, { text: "lost" });
    const payload = JSON.parse(row.payload) as { text: string };
    payload.text = "♻️ Recovered reply\nlost";
    row.payload = JSON.stringify(payload);

    const stale = ledger.redeliverOnBoot(1_000_000 + 60_000);
    expect(stale).toHaveLength(1);
    const recovered = JSON.parse(stale[0]!.payload) as { text: string };
    expect(recovered.text).toBe("♻️ Recovered reply\nlost");
  });

  it("fails stale rows older than the freshness window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const ledger = new DeliveryLedger();
    const old = ledger.begin(SESSION, PLATFORM, CHAT, { text: "ancient" });
    // 25 hours later.
    const stale = ledger.redeliverOnBoot(1_000_000 + 25 * 3600_000);
    expect(stale).toHaveLength(0);
    expect(ledger.listForSession(SESSION)[0]?.state).toBe("failed");
    void old;
  });

  it("fails rows that exhausted their attempts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const ledger = new DeliveryLedger();
    const row = ledger.begin(SESSION, PLATFORM, CHAT, { text: "tired" });
    ledger.fail(row.rowId);
    ledger.fail(row.rowId);
    ledger.fail(row.rowId);
    expect(ledger.redeliverOnBoot(1_000_000 + 60_000)).toHaveLength(0);
    expect(ledger.listForSession(SESSION)[0]?.state).toBe("failed");
  });

  it("leaves delivered and failed rows untouched", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const ledger = new DeliveryLedger();
    const delivered = ledger.begin(SESSION, PLATFORM, CHAT, { text: "ok" });
    ledger.ack(delivered.rowId);
    const failed = ledger.begin(SESSION, PLATFORM, CHAT, { text: "bad" });
    ledger.fail(failed.rowId);
    ledger.fail(failed.rowId);
    ledger.fail(failed.rowId);

    expect(ledger.redeliverOnBoot(1_000_000 + 60_000)).toHaveLength(0);
    const rows = ledger.listForSession(SESSION);
    expect(rows.map((r) => r.state).sort()).toEqual(["delivered", "failed"]);
  });
});

describe("DeliveryLedger.dedupeMedia", () => {
  it("never filters explicit media", () => {
    const ledger = new DeliveryLedger();
    const row = ledger.begin(SESSION, PLATFORM, CHAT, { text: "pic", mediaPath: "/tmp/a.png" });
    ledger.ack(row.rowId);
    expect(ledger.dedupeMedia(SESSION, "/tmp/a.png", true)).toBe(false);
  });

  it("filters bare paths already delivered for the same session", () => {
    const ledger = new DeliveryLedger();
    const row = ledger.begin(SESSION, PLATFORM, CHAT, { text: "pic", mediaPath: "/tmp/a.png" });
    ledger.ack(row.rowId);
    expect(ledger.dedupeMedia(SESSION, "/tmp/a.png", false)).toBe(true);
  });

  it("does not filter pending rows, other sessions, or unknown paths", () => {
    const ledger = new DeliveryLedger();
    const row = ledger.begin(SESSION, PLATFORM, CHAT, { text: "pic", mediaPath: "/tmp/a.png" });
    expect(ledger.dedupeMedia(SESSION, "/tmp/a.png", false)).toBe(false); // pending

    ledger.ack(row.rowId);
    expect(ledger.dedupeMedia("other_sess", "/tmp/a.png", false)).toBe(false);
    expect(ledger.dedupeMedia(SESSION, "/tmp/b.png", false)).toBe(false);
  });

  it("filters only the deduped path — text-only rows never match", () => {
    const ledger = new DeliveryLedger();
    const row = ledger.begin(SESSION, PLATFORM, CHAT, { text: "plain" });
    ledger.ack(row.rowId);
    expect(ledger.dedupeMedia(SESSION, "/tmp/a.png", false)).toBe(false);
  });
});

describe("DeliveryLedger.listForSession", () => {
  it("returns only rows for the requested session in insertion order", () => {
    const ledger = new DeliveryLedger();
    const a = ledger.begin(SESSION, PLATFORM, CHAT, { text: "a" });
    const b = ledger.begin("other", PLATFORM, CHAT, { text: "b" });
    const c = ledger.begin(SESSION, PLATFORM, CHAT, { text: "c" });
    expect(ledger.listForSession(SESSION).map((r) => r.rowId)).toEqual([a.rowId, c.rowId]);
    expect(ledger.listForSession("empty")).toEqual([]);
    void b;
  });
});
