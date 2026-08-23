import { describe, expect, it } from "vitest";
import {
  AcpInitializeParamsSchema,
  AcpSessionRowSchema,
  AcpSessionStateSchema,
  AcpStatusSchema,
  ApprovalDecisionSchema,
} from "./acp";

describe("AcpSessionStateSchema", () => {
  it("parses a full session state", () => {
    const parsed = AcpSessionStateSchema.parse({
      sessionId: "sess_1",
      cwd: "/work",
      model: "claude-opus",
      mode: "accept_edits",
      history: [{ role: "user" }],
      queuedPrompts: ["/help"],
      isRunning: true,
      currentPromptText: "fix the bug",
    });
    expect(parsed.sessionId).toBe("sess_1");
    expect(parsed.mode).toBe("accept_edits");
    expect(parsed.history).toHaveLength(1);
    expect(parsed.queuedPrompts).toEqual(["/help"]);
    expect(parsed.isRunning).toBe(true);
    expect(parsed.currentPromptText).toBe("fix the bug");
  });

  it("applies defaults for optional and defaulted fields", () => {
    const parsed = AcpSessionStateSchema.parse({ sessionId: "sess_2" });
    expect(parsed.mode).toBe("default");
    expect(parsed.history).toEqual([]);
    expect(parsed.queuedPrompts).toEqual([]);
    expect(parsed.isRunning).toBe(false);
    expect(parsed.cwd).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.currentPromptText).toBeUndefined();
  });

  it("rejects an unknown mode", () => {
    const result = AcpSessionStateSchema.safeParse({ sessionId: "x", mode: "auto" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing sessionId", () => {
    const result = AcpSessionStateSchema.safeParse({ isRunning: true });
    expect(result.success).toBe(false);
  });

  it("rejects a non-array history", () => {
    const result = AcpSessionStateSchema.safeParse({ sessionId: "x", history: "nope" });
    expect(result.success).toBe(false);
  });

  it("strips unknown keys", () => {
    const parsed = AcpSessionStateSchema.parse({ sessionId: "x", extra: 1 });
    expect(parsed).not.toHaveProperty("extra");
  });
});

describe("AcpSessionRowSchema", () => {
  it("parses a full session row", () => {
    const parsed = AcpSessionRowSchema.parse({
      id: "row_1",
      cwd: "/work",
      model: "gpt-5",
      title: "Fixing tests",
      preview: "wip",
      messageCount: 4,
      lastActive: 1700000000000,
      startedAt: 1699999999000,
      historyJson: "[]",
      parentSessionId: "row_0",
      endReason: "done",
    });
    expect(parsed.id).toBe("row_1");
    expect(parsed.messageCount).toBe(4);
    expect(parsed.parentSessionId).toBe("row_0");
    expect(parsed.endReason).toBe("done");
  });

  it("defaults messageCount to 0", () => {
    const parsed = AcpSessionRowSchema.parse({
      id: "row_2",
      lastActive: 1,
      startedAt: 1,
    });
    expect(parsed.messageCount).toBe(0);
  });

  it("rejects rows missing required fields", () => {
    expect(AcpSessionRowSchema.safeParse({ id: "x" }).success).toBe(false);
    expect(AcpSessionRowSchema.safeParse({ lastActive: 1, startedAt: 1 }).success).toBe(false);
    expect(AcpSessionRowSchema.safeParse({ id: "x", lastActive: 1 }).success).toBe(false);
  });

  it("rejects a non-number messageCount", () => {
    const result = AcpSessionRowSchema.safeParse({
      id: "x",
      lastActive: 1,
      startedAt: 1,
      messageCount: "many",
    });
    expect(result.success).toBe(false);
  });
});

describe("ApprovalDecisionSchema", () => {
  it("accepts every decision value", () => {
    for (const v of ["once", "session", "always", "deny", "timeout", "cancelled"]) {
      expect(ApprovalDecisionSchema.parse(v)).toBe(v);
    }
  });

  it("rejects unknown decisions", () => {
    expect(ApprovalDecisionSchema.safeParse("approve").success).toBe(false);
    expect(ApprovalDecisionSchema.safeParse(1).success).toBe(false);
  });
});

describe("AcpInitializeParamsSchema", () => {
  it("parses minimal init params", () => {
    const parsed = AcpInitializeParamsSchema.parse({
      protocolVersion: "0.1.0",
      clientInfo: { name: "hermes", version: "1.0.0" },
    });
    expect(parsed.protocolVersion).toBe("0.1.0");
    expect(parsed.clientInfo.name).toBe("hermes");
    expect(parsed.capabilities).toBeUndefined();
  });

  it("accepts optional capabilities as a record", () => {
    const parsed = AcpInitializeParamsSchema.parse({
      protocolVersion: "0.1.0",
      capabilities: { editing: { acceptsEdits: true } },
      clientInfo: { name: "hermes", version: "1.0.0" },
    });
    expect(parsed.capabilities).toEqual({ editing: { acceptsEdits: true } });
  });

  it("rejects missing protocolVersion or clientInfo", () => {
    expect(
      AcpInitializeParamsSchema.safeParse({ clientInfo: { name: "x", version: "1" } }).success,
    ).toBe(false);
    expect(
      AcpInitializeParamsSchema.safeParse({ protocolVersion: "0.1.0" }).success,
    ).toBe(false);
    expect(
      AcpInitializeParamsSchema.safeParse({
        protocolVersion: "0.1.0",
        clientInfo: { name: "x" },
      }).success,
    ).toBe(false);
  });
});

describe("AcpStatusSchema", () => {
  it("parses running status with optional pid", () => {
    expect(AcpStatusSchema.parse({ running: true, pid: 1234 })).toEqual({
      running: true,
      pid: 1234,
    });
    expect(AcpStatusSchema.parse({ running: false })).toEqual({ running: false });
  });

  it("rejects a missing running flag or non-boolean", () => {
    expect(AcpStatusSchema.safeParse({}).success).toBe(false);
    expect(AcpStatusSchema.safeParse({ running: "yes" }).success).toBe(false);
  });
});
