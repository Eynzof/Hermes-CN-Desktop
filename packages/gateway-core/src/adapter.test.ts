import { describe, expect, it } from "vitest";
import {
  inboundMessageEventSchema,
  messagePartSchema,
  outboundContentSchema,
  platformStatusSchema,
  sendMetaSchema,
  sendResultSchema,
} from "./adapter.js";

describe("platformStatusSchema", () => {
  it("accepts every lifecycle status", () => {
    for (const s of ["idle", "connecting", "running", "error", "stopped"]) {
      expect(platformStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects unknown statuses", () => {
    expect(platformStatusSchema.safeParse("paused").success).toBe(false);
    expect(platformStatusSchema.safeParse(3).success).toBe(false);
  });
});

describe("messagePartSchema", () => {
  it("parses a text part", () => {
    const parsed = messagePartSchema.parse({ type: "text", text: "hello" });
    expect(parsed).toEqual({ type: "text", text: "hello" });
  });

  it("parses image parts with optional url/path/mime", () => {
    expect(messagePartSchema.parse({ type: "image", url: "https://x/y.png" })).toMatchObject({
      type: "image",
      url: "https://x/y.png",
    });
    expect(
      messagePartSchema.parse({ type: "image", path: "/tmp/a.png", mime: "image/png" }),
    ).toMatchObject({ type: "image", path: "/tmp/a.png", mime: "image/png" });
    expect(messagePartSchema.parse({ type: "image" })).toEqual({ type: "image" });
  });

  it("parses voice parts requiring a path", () => {
    const parsed = messagePartSchema.parse({
      type: "voice",
      path: "/tmp/a.ogg",
      mime: "audio/ogg",
      durationMs: 1234,
    });
    expect(parsed).toMatchObject({ type: "voice", path: "/tmp/a.ogg", durationMs: 1234 });
    expect(messagePartSchema.safeParse({ type: "voice" }).success).toBe(false);
    expect(messagePartSchema.safeParse({ type: "voice", mime: "audio/ogg" }).success).toBe(false);
  });

  it("rejects unknown part types and missing text", () => {
    expect(messagePartSchema.safeParse({ type: "video", url: "u" }).success).toBe(false);
    expect(messagePartSchema.safeParse({ type: "text" }).success).toBe(false);
  });
});

describe("inboundMessageEventSchema", () => {
  const base = {
    id: "ev1",
    platform: "telegram",
    chatId: "99",
    chatType: "dm",
    userId: "u1",
    parts: [{ type: "text", text: "hi" }],
    receivedAt: 1700000000000,
  };

  it("parses a minimal inbound event", () => {
    const parsed = inboundMessageEventSchema.parse(base);
    expect(parsed.chatType).toBe("dm");
    expect(parsed.username).toBeUndefined();
    expect(parsed.threadId).toBeUndefined();
    expect(parsed.scopeId).toBeUndefined();
    expect(parsed.raw).toBeUndefined();
  });

  it("parses a full event with optional fields", () => {
    const parsed = inboundMessageEventSchema.parse({
      ...base,
      chatType: "group",
      username: "alice",
      threadId: "t1",
      scopeId: "scope1",
      raw: { message_id: 42 },
    });
    expect(parsed.username).toBe("alice");
    expect(parsed.threadId).toBe("t1");
    expect(parsed.scopeId).toBe("scope1");
    expect(parsed.raw).toEqual({ message_id: 42 });
  });

  it("rejects invalid chat types and missing required fields", () => {
    expect(inboundMessageEventSchema.safeParse({ ...base, chatType: "broadcast" }).success).toBe(false);
    expect(inboundMessageEventSchema.safeParse({ ...base, id: undefined }).success).toBe(false);
    expect(inboundMessageEventSchema.safeParse({ ...base, receivedAt: "now" }).success).toBe(false);
    expect(inboundMessageEventSchema.safeParse({ ...base, parts: [] }).success).toBe(true);
  });

  it("rejects invalid parts inside the event", () => {
    expect(
      inboundMessageEventSchema.safeParse({ ...base, parts: [{ type: "text" }] }).success,
    ).toBe(false);
  });
});

describe("sendResultSchema", () => {
  it("parses ok results with optional messageId/error", () => {
    expect(sendResultSchema.parse({ ok: true, messageId: "m1" })).toEqual({ ok: true, messageId: "m1" });
    expect(sendResultSchema.parse({ ok: false, error: "timeout" }).error).toBe("timeout");
    expect(sendResultSchema.parse({ ok: true }).messageId).toBeUndefined();
  });

  it("rejects a missing ok flag", () => {
    expect(sendResultSchema.safeParse({}).success).toBe(false);
  });
});

describe("sendMetaSchema", () => {
  it("parses empty meta and full meta", () => {
    expect(sendMetaSchema.parse({})).toEqual({});
    const parsed = sendMetaSchema.parse({ replyTo: "m1", threadId: "t1", silent: true });
    expect(parsed).toEqual({ replyTo: "m1", threadId: "t1", silent: true });
  });

  it("rejects a non-boolean silent flag", () => {
    expect(sendMetaSchema.safeParse({ silent: "yes" }).success).toBe(false);
  });
});

describe("outboundContentSchema", () => {
  it("parses text content", () => {
    expect(outboundContentSchema.parse({ type: "text", text: "reply" })).toEqual({
      type: "text",
      text: "reply",
    });
  });

  it("parses multi-part content", () => {
    const parsed = outboundContentSchema.parse({
      type: "parts",
      parts: [
        { type: "text", text: "see" },
        { type: "image", path: "/tmp/x.png" },
      ],
    });
    expect(parsed.type).toBe("parts");
    if (parsed.type === "parts") {
      expect(parsed.parts).toHaveLength(2);
    }
  });

  it("rejects unknown content shapes", () => {
    expect(outboundContentSchema.safeParse({ type: "document", path: "/x" }).success).toBe(false);
    expect(outboundContentSchema.safeParse({ type: "text" }).success).toBe(false);
    expect(outboundContentSchema.safeParse({ type: "parts", parts: [] }).success).toBe(true);
  });
});
