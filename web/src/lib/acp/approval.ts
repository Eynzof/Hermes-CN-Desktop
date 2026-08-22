import type { ApprovalDecision } from "./types.js";

export const PERMISSION_OPTIONS = [
  { id: "allow_once", label: "Allow once" },
  { id: "allow_session", label: "Allow for this session" },
  { id: "allow_always", label: "Always allow" },
  { id: "deny", label: "Deny" },
  { id: "deny_always", label: "Always deny" },
] as const;

export function mapAcpDecisionToHermes(decision: ApprovalDecision): string {
  switch (decision) {
    case "once":
      return "once";
    case "session":
      return "session";
    case "always":
      return "always";
    case "deny":
      return "deny";
    case "timeout":
    case "cancelled":
      return "deny";
  }
}
