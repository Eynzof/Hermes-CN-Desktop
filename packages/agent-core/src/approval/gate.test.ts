import { describe, expect, it } from "vitest";
import { ApprovalGate, createApprovalEventEmitter, type ApprovalEvent } from "./gate.js";
import { buildDefaultApprovalPolicy } from "./policy.js";
import type { ApprovalRequest } from "./types.js";

function req(partial: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "",
    sessionId: "s-1",
    toolName: "execute_code",
    dangerLevel: "high",
    ...partial,
  };
}

describe("ApprovalGate", () => {
  it("auto-approves safe requests in manual mode", async () => {
    const gate = new ApprovalGate({
      policy: buildDefaultApprovalPolicy({ mode: "manual" }),
    });
    const result = await gate.request(req({ toolName: "read_file", dangerLevel: "none" }));
    expect(result.decision).toBe("approve");
  });

  it("auto-denies hardline requests before YOLO", async () => {
    const gate = new ApprovalGate({
      policy: buildDefaultApprovalPolicy({ mode: "yolo" }),
    });
    const result = await gate.request(req({ dangerLevel: "critical" }));
    expect(result.decision).toBe("deny");
  });

  it("auto-approves everything when YOLO is active (except hardline)", async () => {
    const gate = new ApprovalGate({
      policy: buildDefaultApprovalPolicy({ mode: "yolo" }),
    });
    const result = await gate.request(req({ dangerLevel: "high" }));
    expect(result.decision).toBe("approve");
  });

  it("holds dangerous manual-mode requests as pending", async () => {
    const gate = new ApprovalGate({
      policy: buildDefaultApprovalPolicy({ mode: "manual" }),
    });
    const promise = gate.request(req({ dangerLevel: "high" }));
    expect(gate.listPending()).toHaveLength(1);
    gate.resolve(gate.listPending()[0].id, { decision: "approve", scope: "once" });
    const result = await promise;
    expect(result.decision).toBe("approve");
    expect(gate.listPending()).toHaveLength(0);
  });

  it("emits approval events", async () => {
    const events: ApprovalEvent[] = [];
    const gate = new ApprovalGate({
      policy: buildDefaultApprovalPolicy({ mode: "manual" }),
      emitter: createApprovalEventEmitter(),
    });
    gate.on((e) => events.push(e));
    const promise = gate.request(req({ dangerLevel: "high" }));
    expect(events.some((e) => e.type === "approval.requested")).toBe(true);
    gate.resolve(gate.listPending()[0].id, { decision: "deny" });
    await promise;
    expect(events.some((e) => e.type === "approval.resolved")).toBe(true);
  });

  it("denies pending requests on timeout", async () => {
    const gate = new ApprovalGate({
      policy: buildDefaultApprovalPolicy({ mode: "manual" }),
      timeoutMs: 10,
    });
    const result = await gate.request(req({ dangerLevel: "high" }));
    expect(result.decision).toBe("deny");
    expect(gate.listPending()).toHaveLength(0);
  });

  it("resolves only by id and returns false for unknown ids", () => {
    const gate = new ApprovalGate({
      policy: buildDefaultApprovalPolicy({ mode: "manual" }),
    });
    gate.request(req({ dangerLevel: "high" }));
    expect(gate.resolve("unknown", { decision: "approve" })).toBe(false);
    expect(gate.listPending()).toHaveLength(1);
  });

  it("cancels all pending requests for a session", async () => {
    const gate = new ApprovalGate({
      policy: buildDefaultApprovalPolicy({ mode: "manual" }),
    });
    const p1 = gate.request(req({ sessionId: "s-1", dangerLevel: "high" }));
    gate.request(req({ sessionId: "s-2", dangerLevel: "high" }));
    gate.cancelSession("s-1");
    const r1 = await p1;
    expect(r1.decision).toBe("deny");
    expect(gate.listPending()).toHaveLength(1);
  });
});
