import { describe, expect, it } from "vitest";
import { mapAcpDecisionToHermes, PERMISSION_OPTIONS } from "./approval";
import type { ApprovalDecision } from "./types";

describe("PERMISSION_OPTIONS", () => {
  it("exposes the five ACP permission choices in order", () => {
    expect(PERMISSION_OPTIONS.map((o) => o.id)).toEqual([
      "allow_once",
      "allow_session",
      "allow_always",
      "deny",
      "deny_always",
    ]);
  });

  it("provides human-readable labels for every option", () => {
    for (const option of PERMISSION_OPTIONS) {
      expect(option.label).toBeTruthy();
    }
    expect(PERMISSION_OPTIONS[0].label).toBe("Allow once");
    expect(PERMISSION_OPTIONS[1].label).toBe("Allow for this session");
    expect(PERMISSION_OPTIONS[2].label).toBe("Always allow");
    expect(PERMISSION_OPTIONS[3].label).toBe("Deny");
    expect(PERMISSION_OPTIONS[4].label).toBe("Always deny");
  });

  it("is a typed readonly tuple of literal ids", () => {
    const ids: readonly string[] = PERMISSION_OPTIONS.map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining(["allow_once", "deny_always"]));
  });
});

describe("mapAcpDecisionToHermes", () => {
  it("maps positive decisions to the same hermes approval mode", () => {
    expect(mapAcpDecisionToHermes("once")).toBe("once");
    expect(mapAcpDecisionToHermes("session")).toBe("session");
    expect(mapAcpDecisionToHermes("always")).toBe("always");
    expect(mapAcpDecisionToHermes("deny")).toBe("deny");
  });

  it("maps timeout and cancelled to deny", () => {
    expect(mapAcpDecisionToHermes("timeout")).toBe("deny");
    expect(mapAcpDecisionToHermes("cancelled")).toBe("deny");
  });

  it("covers every decision in the protocol type", () => {
    const decisions: ApprovalDecision[] = [
      "once",
      "session",
      "always",
      "deny",
      "timeout",
      "cancelled",
    ];
    for (const decision of decisions) {
      const mapped = mapAcpDecisionToHermes(decision);
      expect(["once", "session", "always", "deny"]).toContain(mapped);
    }
  });

  it("is a total function over the union (no throw on edge values)", () => {
    expect(() => mapAcpDecisionToHermes("timeout" as ApprovalDecision)).not.toThrow();
    expect(mapAcpDecisionToHermes("timeout" as ApprovalDecision)).toBe("deny");
  });
});
