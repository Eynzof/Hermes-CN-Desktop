import { describe, expect, it } from "vitest";
import { handleMemoryCommand, type MemoryCommandContext, type MemoryPendingRecord } from "./memory";

function makeContext(initialApproval = false): {
  ctx: MemoryCommandContext;
  approved: string[];
  rejected: string[];
  approvalEnabled: boolean;
} {
  const pending: MemoryPendingRecord[] = [
    {
      id: "abc123",
      subsystem: "memory",
      action: "add",
      summary: "user likes dark mode",
      origin: "foreground",
      createdAt: "2024-01-01T00:00:00Z",
      payload: { action: "add_memory", scope: "memory", content: "user likes dark mode" },
    },
    {
      id: "def456",
      subsystem: "memory",
      action: "add",
      summary: "background summary",
      origin: "background",
      createdAt: "2024-01-01T01:00:00Z",
      payload: { action: "add_memory", scope: "memory", content: "background fact" },
    },
  ];
  const approved: string[] = [];
  const rejected: string[] = [];
  let approvalEnabled = initialApproval;

  return {
    ctx: {
      isApprovalEnabled: () => approvalEnabled,
      setApprovalEnabled: async (enabled: boolean) => {
        approvalEnabled = enabled;
      },
      listPending: async () => pending,
      approvePending: async (id: string) => {
        if (pending.some((r) => r.id === id)) {
          approved.push(id);
          return true;
        }
        return false;
      },
      rejectPending: async (id: string) => {
        if (pending.some((r) => r.id === id)) {
          rejected.push(id);
          return true;
        }
        return false;
      },
    },
    approved,
    rejected,
    get approvalEnabled() {
      return approvalEnabled;
    },
  };
}

describe("handleMemoryCommand", () => {
  it("lists pending writes", async () => {
    const { ctx } = makeContext();
    const result = await handleMemoryCommand("pending", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("abc123");
    expect(result.output).toContain("def456 [auto]");
  });

  it("approves a single pending write", async () => {
    const { ctx, approved } = makeContext();
    const result = await handleMemoryCommand("approve abc123", ctx);
    expect(result.type).toBe("exec");
    expect(approved).toEqual(["abc123"]);
  });

  it("approves all pending writes", async () => {
    const { ctx, approved } = makeContext();
    const result = await handleMemoryCommand("approve all", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("2");
    expect(approved).toEqual(["abc123", "def456"]);
  });

  it("rejects a single pending write", async () => {
    const { ctx, rejected } = makeContext();
    const result = await handleMemoryCommand("reject abc123", ctx);
    expect(result.type).toBe("exec");
    expect(rejected).toEqual(["abc123"]);
  });

  it("rejects all pending writes", async () => {
    const { ctx, rejected } = makeContext();
    const result = await handleMemoryCommand("reject all", ctx);
    expect(result.type).toBe("exec");
    expect(rejected).toEqual(["abc123", "def456"]);
  });

  it("toggles approval on", async () => {
    const { ctx } = makeContext(false);
    const result = await handleMemoryCommand("approval on", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("enabled");
  });

  it("toggles approval off", async () => {
    const { ctx } = makeContext(true);
    const result = await handleMemoryCommand("approval off", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("disabled");
  });

  it("reports approval status", async () => {
    const { ctx } = makeContext(true);
    const result = await handleMemoryCommand("approval", ctx);
    expect(result.type).toBe("exec");
    expect(result.output).toContain("enabled");
  });

  it("errors on unknown subcommand", async () => {
    const { ctx } = makeContext();
    const result = await handleMemoryCommand("bogus", ctx);
    expect(result.type).toBe("error");
  });
});
