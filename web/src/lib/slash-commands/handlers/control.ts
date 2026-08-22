import type { CommandResult } from "../types";
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
  clampReasoning,
  getSessionReasoning,
  setSessionReasoning,
  type SessionReasoningPrefs,
} from "@/lib/reasoning-effort";
import {
  approvalModeLabel,
  getProcessApprovalMode,
  isSessionYolo,
  normalizeApprovalMode,
  setProcessApprovalMode,
  setSessionYolo,
  type ApprovalMode,
} from "@/lib/approval-mode";

export interface ControlHandlerContext {
  activeSessionId: string | null;
}

const sessionFastMode = new Map<string, boolean>();

function requireSession(ctx: ControlHandlerContext): string | null {
  return ctx.activeSessionId;
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

function reasoningStatus(prefs: SessionReasoningPrefs): string {
  const effort = prefs.effort ?? "default";
  const display = prefs.show ? (prefs.full ? "full" : "clamp") : "hidden";
  return `Reasoning: effort=${effort}, display=${display}`;
}

function fastStatus(sessionId: string | null): string {
  if (!sessionId) return "Fast mode: off";
  const enabled = sessionFastMode.get(sessionId) ?? false;
  return `Fast mode: ${enabled ? "on" : "off"}`;
}

function yoloStatus(sessionId: string | null): string {
  if (!sessionId) return "YOLO: off (no session)";
  const enabled = isSessionYolo(sessionId);
  return `YOLO: ${enabled ? "ON" : "OFF"}`;
}

function approvalsStatus(): string {
  const mode = getProcessApprovalMode();
  return `Approvals: ${approvalModeLabel(mode)} (${mode})`;
}

export function handleReasoningCommand(
  args: string,
  ctx: ControlHandlerContext,
): CommandResult {
  const sessionId = requireSession(ctx);
  if (!sessionId) {
    return { type: "error", message: "/reasoning requires an active session" };
  }

  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase();

  if (!first || first === "status") {
    return {
      type: "exec",
      output: reasoningStatus(getSessionReasoning(sessionId)),
    };
  }

  // Display toggles
  if (first === "show" || first === "on") {
    setSessionReasoning(sessionId, { show: true });
    return { type: "exec", output: reasoningStatus(getSessionReasoning(sessionId)) };
  }
  if (first === "hide" || first === "off") {
    setSessionReasoning(sessionId, { show: false });
    return { type: "exec", output: reasoningStatus(getSessionReasoning(sessionId)) };
  }
  if (first === "full") {
    setSessionReasoning(sessionId, { full: true });
    return { type: "exec", output: reasoningStatus(getSessionReasoning(sessionId)) };
  }
  if (first === "clamp") {
    setSessionReasoning(sessionId, { full: false });
    return { type: "exec", output: reasoningStatus(getSessionReasoning(sessionId)) };
  }

  // Effort level
  if (isReasoningEffort(first)) {
    const global = tokens.includes("--global");
    if (global) {
      // TODO: wire through the config bridge once the migration to embedded DB lands.
      return {
        type: "exec",
        output: `Global reasoning effort (${first}) is not yet persisted locally.`,
      };
    }
    const enabled = first !== "none";
    setSessionReasoning(sessionId, { effort: first, enabled });
    return { type: "exec", output: reasoningStatus(getSessionReasoning(sessionId)) };
  }

  return {
    type: "error",
    message: `Unknown /reasoning argument: ${args}. Try: low|medium|high|show|hide|full|clamp`,
  };
}

export function handleFastCommand(
  args: string,
  ctx: ControlHandlerContext,
): CommandResult {
  const sessionId = requireSession(ctx);
  if (!sessionId) {
    return { type: "error", message: "/fast requires an active session" };
  }

  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase();

  if (!first || first === "status") {
    return { type: "exec", output: fastStatus(sessionId) };
  }

  const global = tokens.includes("--global");
  const enabled = first === "on" || first === "fast";
  const disabled = first === "off" || first === "normal";

  if (enabled) {
    if (global) {
      return {
        type: "exec",
        output: "Global fast mode is not yet persisted locally.",
      };
    }
    sessionFastMode.set(sessionId, true);
    return { type: "exec", output: fastStatus(sessionId) };
  }

  if (disabled) {
    if (global) {
      return {
        type: "exec",
        output: "Global fast mode is not yet persisted locally.",
      };
    }
    sessionFastMode.set(sessionId, false);
    return { type: "exec", output: fastStatus(sessionId) };
  }

  return {
    type: "error",
    message: `Unknown /fast argument: ${args}. Try: on|off`,
  };
}

export function handleYoloCommand(
  args: string,
  ctx: ControlHandlerContext,
): CommandResult {
  const sessionId = requireSession(ctx);
  if (!sessionId) {
    return { type: "error", message: "/yolo requires an active session" };
  }

  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase();
  const current = isSessionYolo(sessionId);

  let next: boolean;
  if (first === "on") next = true;
  else if (first === "off") next = false;
  else next = !current;

  setSessionYolo(sessionId, next);
  return { type: "exec", output: `YOLO: ${next ? "ON" : "OFF"}` };
}

export function handleApprovalsCommand(
  args: string,
  _ctx: ControlHandlerContext,
): CommandResult {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase();

  if (!first || first === "status") {
    return { type: "exec", output: approvalsStatus() };
  }

  const mode = normalizeApprovalMode(first);
  if (mode === "default") {
    // "default" means manual in the process-level vocabulary.
    setProcessApprovalMode("manual");
  } else {
    setProcessApprovalMode(mode);
  }
  return { type: "exec", output: approvalsStatus() };
}

export function isFastModeEnabled(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return sessionFastMode.get(sessionId) ?? false;
}

export function clampReasoningText(text: string, full: boolean): string {
  return full ? text : clampReasoning(text);
}
