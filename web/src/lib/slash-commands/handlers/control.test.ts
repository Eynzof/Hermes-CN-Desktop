import { describe, expect, it } from "vitest";
import {
  handleApprovalsCommand,
  handleFastCommand,
  handleReasoningCommand,
  handleYoloCommand,
  isFastModeEnabled,
} from "./control";
import {
  clearSessionReasoning,
  getSessionReasoning,
  normalizeReasoningEffort,
} from "@/lib/reasoning-effort";
import {
  getProcessApprovalMode,
  isSessionYolo,
  setProcessApprovalMode,
} from "@/lib/approval-mode";

function ctx(sessionId: string | null = "session-1") {
  return { activeSessionId: sessionId };
}

describe("handleReasoningCommand", () => {
  it("shows status when no argument is given", () => {
    const result = handleReasoningCommand("", ctx());
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Reasoning:");
  });

  it("sets session effort", () => {
    handleReasoningCommand("high", ctx());
    expect(getSessionReasoning("session-1").effort).toBe("high");
    expect(getSessionReasoning("session-1").enabled).toBe(true);
  });

  it("disables reasoning for 'none'", () => {
    handleReasoningCommand("none", ctx());
    expect(getSessionReasoning("session-1").effort).toBe("none");
    expect(getSessionReasoning("session-1").enabled).toBe(false);
  });

  it("supports ultra effort", () => {
    handleReasoningCommand("ultra", ctx());
    expect(getSessionReasoning("session-1").effort).toBe("ultra");
  });

  it("toggles display modes", () => {
    handleReasoningCommand("hide", ctx());
    expect(getSessionReasoning("session-1").show).toBe(false);
    handleReasoningCommand("show", ctx());
    expect(getSessionReasoning("session-1").show).toBe(true);
    handleReasoningCommand("full", ctx());
    expect(getSessionReasoning("session-1").full).toBe(true);
    handleReasoningCommand("clamp", ctx());
    expect(getSessionReasoning("session-1").full).toBe(false);
  });

  it("isolates sessions", () => {
    handleReasoningCommand("low", ctx("session-a"));
    handleReasoningCommand("high", ctx("session-b"));
    expect(getSessionReasoning("session-a").effort).toBe("low");
    expect(getSessionReasoning("session-b").effort).toBe("high");
    clearSessionReasoning("session-a");
    expect(getSessionReasoning("session-a").effort).toBeNull();
    expect(getSessionReasoning("session-b").effort).toBe("high");
  });
});

describe("handleFastCommand", () => {
  it("toggles fast mode per session", () => {
    handleFastCommand("on", ctx("s-1"));
    handleFastCommand("off", ctx("s-2"));
    expect(isFastModeEnabled("s-1")).toBe(true);
    expect(isFastModeEnabled("s-2")).toBe(false);
  });

  it("returns status", () => {
    const result = handleFastCommand("", ctx("s-1"));
    expect(result.output).toBe("Fast mode: on");
  });
});

describe("handleYoloCommand", () => {
  it("toggles session YOLO", () => {
    const first = handleYoloCommand("", ctx("s-1"));
    expect(first.output).toBe("YOLO: ON");
    expect(isSessionYolo("s-1")).toBe(true);

    const second = handleYoloCommand("", ctx("s-1"));
    expect(second.output).toBe("YOLO: OFF");
    expect(isSessionYolo("s-1")).toBe(false);
  });

  it("isolates sessions", () => {
    handleYoloCommand("on", ctx("s-a"));
    expect(isSessionYolo("s-a")).toBe(true);
    expect(isSessionYolo("s-b")).toBe(false);
  });

  it("requires an active session", () => {
    const result = handleYoloCommand("on", ctx(null));
    expect(result.type).toBe("error");
  });
});

describe("handleApprovalsCommand", () => {
  it("sets the process approval mode", () => {
    setProcessApprovalMode("default");
    handleApprovalsCommand("smart", ctx());
    expect(getProcessApprovalMode()).toBe("smart");
    handleApprovalsCommand("yolo", ctx());
    expect(getProcessApprovalMode()).toBe("yolo");
    handleApprovalsCommand("manual", ctx());
    expect(getProcessApprovalMode()).toBe("default");
  });

  it("normalizes off to yolo", () => {
    handleApprovalsCommand("off", ctx());
    expect(getProcessApprovalMode()).toBe("yolo");
  });

  it("returns status", () => {
    const result = handleApprovalsCommand("", ctx());
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Approvals:");
  });
});
