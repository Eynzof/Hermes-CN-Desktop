import { describe, expect, it } from "vitest";
import {
  CompositePolicy,
  DangerLevelPolicy,
  ToolNamePolicy,
  ToolsetPolicy,
  YoloPolicy,
  buildDefaultApprovalPolicy,
} from "./policy.js";
import type { ApprovalRequest, ApprovalMode } from "./types.js";

function req(partial: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "r-1",
    sessionId: "s-1",
    toolName: "execute_code",
    dangerLevel: "high",
    ...partial,
  };
}

describe("DangerLevelPolicy", () => {
  it("asks for operations at or above the threshold", () => {
    const policy = new DangerLevelPolicy("medium", "critical");
    expect(policy.evaluate(req({ dangerLevel: "medium" }))).toEqual({
      decision: "ask",
      reason: "Danger level medium",
    });
    expect(policy.evaluate(req({ dangerLevel: "high" }))?.decision).toBe("ask");
  });

  it("denies hardline levels", () => {
    const policy = new DangerLevelPolicy("high", "high");
    expect(policy.evaluate(req({ dangerLevel: "high" }))?.decision).toBe("deny");
  });

  it("falls through for safe levels", () => {
    const policy = new DangerLevelPolicy("high", "critical");
    expect(policy.evaluate(req({ dangerLevel: "low" }))).toBeUndefined();
  });
});

describe("ToolsetPolicy", () => {
  it("denies configured toolsets", () => {
    const policy = new ToolsetPolicy({ deny: ["terminal"] });
    expect(policy.evaluate(req({ toolset: "terminal" }))).toEqual({
      decision: "deny",
      reason: "Denied toolset: terminal",
    });
  });

  it("approves configured toolsets", () => {
    const policy = new ToolsetPolicy({ allow: ["memory"] });
    expect(policy.evaluate(req({ toolset: "memory" }))?.decision).toBe("approve");
  });

  it("is case-insensitive", () => {
    const policy = new ToolsetPolicy({ deny: ["Terminal"] });
    expect(policy.evaluate(req({ toolset: "terminal" }))?.decision).toBe("deny");
  });
});

describe("ToolNamePolicy", () => {
  it("denies configured tools", () => {
    const policy = new ToolNamePolicy({ deny: ["rm_rf"] });
    expect(policy.evaluate(req({ toolName: "rm_rf" }))?.decision).toBe("deny");
  });

  it("approves configured tools", () => {
    const policy = new ToolNamePolicy({ allow: ["read_file"] });
    expect(policy.evaluate(req({ toolName: "read_file" }))?.decision).toBe("approve");
  });
});

describe("YoloPolicy", () => {
  it("approves when active", () => {
    const policy = new YoloPolicy(() => true);
    expect(policy.evaluate(req())).toEqual({ decision: "approve", reason: "YOLO mode active" });
  });

  it("falls through when inactive", () => {
    const policy = new YoloPolicy(() => false);
    expect(policy.evaluate(req())).toBeUndefined();
  });
});

describe("CompositePolicy", () => {
  it("returns the first non-undefined result", () => {
    const policy = new CompositePolicy([
      new ToolNamePolicy({ deny: ["execute_code"] }),
      new YoloPolicy(() => true),
    ]);
    expect(policy.evaluate(req({ toolName: "execute_code" }))?.decision).toBe("deny");
    expect(policy.evaluate(req({ toolName: "safe" }))?.decision).toBe("approve");
  });
});

describe("buildDefaultApprovalPolicy", () => {
  it("places user deny before YOLO", () => {
    const policy = buildDefaultApprovalPolicy({
      mode: "yolo" as ApprovalMode,
      denyTools: ["execute_code"],
    });
    expect(policy.evaluate(req({ toolName: "execute_code" }))?.decision).toBe("deny");
  });

  it("approves dangerous tools when YOLO is active and not denied", () => {
    const policy = buildDefaultApprovalPolicy({
      mode: "yolo" as ApprovalMode,
    });
    expect(policy.evaluate(req({ dangerLevel: "high" }))?.decision).toBe("approve");
  });

  it("asks for high-danger operations in manual mode", () => {
    const policy = buildDefaultApprovalPolicy({ mode: "manual" });
    expect(policy.evaluate(req({ dangerLevel: "high" }))?.decision).toBe("ask");
  });
});
