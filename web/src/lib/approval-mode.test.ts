import { describe, expect, it } from "vitest";
import {
  approvalModeConfigValue,
  hasSmartApprovalCapability,
  isApprovalModeAvailable,
  normalizeApprovalMode,
} from "./approval-mode";

describe("approval mode helpers", () => {
  it.each([
    ["manual", "default"],
    ["default", "default"],
    ["ask", "default"],
    ["smart", "smart"],
    ["yolo", "yolo"],
    ["off", "yolo"],
    ["deny", "default"],
  ] as const)("normalizes %s to %s", (raw, expected) => {
    expect(normalizeApprovalMode(raw)).toBe(expected);
  });

  it("prefers values that exist in the backend schema", () => {
    const modern = ["default", "smart", "yolo"];
    expect(approvalModeConfigValue("default", modern)).toBe("default");
    expect(approvalModeConfigValue("smart", modern)).toBe("smart");
    expect(approvalModeConfigValue("yolo", modern)).toBe("yolo");

    const legacy = ["manual", "smart", "off"];
    expect(approvalModeConfigValue("default", legacy)).toBe("manual");
    expect(approvalModeConfigValue("smart", legacy)).toBe("smart");
    expect(approvalModeConfigValue("yolo", legacy)).toBe("off");

    const old = ["ask", "yolo", "deny"];
    expect(approvalModeConfigValue("default", old)).toBe("ask");
    expect(approvalModeConfigValue("smart", old)).toBe("smart");
    expect(approvalModeConfigValue("yolo", old)).toBe("yolo");
  });

  it("uses smart availability from the schema but keeps default and yolo compatible", () => {
    expect(isApprovalModeAvailable("smart", ["manual", "yolo"])).toBe(false);
    expect(isApprovalModeAvailable("smart", ["manual", "smart", "yolo"])).toBe(true);
    expect(isApprovalModeAvailable("default", ["ask", "deny"])).toBe(true);
    expect(isApprovalModeAvailable("yolo", ["manual", "off"])).toBe(true);
  });

  it("treats v0.16 runtimes with the auxiliary approval slot as smart-capable even when schema options are stale", () => {
    const staleRuntimeFields = {
      "approvals.mode": { options: ["ask", "yolo", "deny"] },
      "auxiliary.approval.provider": { type: "string" },
      "auxiliary.approval.model": { type: "string" },
    };
    expect(hasSmartApprovalCapability(staleRuntimeFields)).toBe(true);
    expect(isApprovalModeAvailable("smart", ["ask", "yolo", "deny"], staleRuntimeFields)).toBe(true);
  });
});
