import { describe, expect, it } from "vitest";
import {
  approvalModeConfigValue,
  clearSessionYolo,
  getProcessApprovalMode,
  hasSmartApprovalCapability,
  isApprovalModeAvailable,
  isSessionYolo,
  normalizeApprovalMode,
  setProcessApprovalMode,
  setSessionYolo,
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
    expect(normalizeApprovalMode(raw as string)).toBe(expected);
  });

  it("accepts the manual type in the union", () => {
    expect(normalizeApprovalMode("manual")).toBe("default");
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

  describe("session YOLO and process mode", () => {
    it("tracks per-session YOLO state", () => {
      setSessionYolo("s-1", true);
      expect(isSessionYolo("s-1")).toBe(true);
      expect(isSessionYolo("s-2")).toBe(false);
      setSessionYolo("s-1", false);
      expect(isSessionYolo("s-1")).toBe(false);
    });

    it("clears session YOLO", () => {
      setSessionYolo("s-1", true);
      clearSessionYolo("s-1");
      expect(isSessionYolo("s-1")).toBe(false);
    });

    it("stores the process-level approval mode", () => {
      setProcessApprovalMode("smart");
      expect(getProcessApprovalMode()).toBe("smart");
      setProcessApprovalMode("manual");
      expect(getProcessApprovalMode()).toBe("default");
    });
  });
});
