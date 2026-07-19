import { describe, expect, it } from "vitest";
import { pickTipRedirect, recordTipRedirect } from "@/lib/session-tip-redirect";

describe("recordTipRedirect", () => {
  it("records a redirect when the backend resumed a different tip", () => {
    const next = recordTipRedirect({}, "old", "tip");
    expect(next).toEqual({ old: "tip" });
  });

  it("returns the same reference when there is nothing to record", () => {
    const prev = { old: "tip" };
    expect(recordTipRedirect(prev, "old", undefined)).toBe(prev); // no resumed id
    expect(recordTipRedirect(prev, undefined, "tip")).toBe(prev); // no requested id
    expect(recordTipRedirect(prev, "same", "same")).toBe(prev); // identity redirect
    expect(recordTipRedirect(prev, "old", "tip")).toBe(prev); // already recorded
  });

  it("merges without dropping existing redirects", () => {
    const next = recordTipRedirect({ a: "a2" }, "b", "b2");
    expect(next).toEqual({ a: "a2", b: "b2" });
  });
});

describe("pickTipRedirect", () => {
  it("returns the tip when the route is still on the pre-compression id", () => {
    const tip = pickTipRedirect(
      { old: "tip" },
      { taskId: "old", restSessionId: "old", activeSessionId: "old" },
    );
    expect(tip).toBe("tip");
  });

  it("matches on restSessionId even when taskId differs", () => {
    const tip = pickTipRedirect(
      { old: "tip" },
      { taskId: "gw-123", restSessionId: "old", activeSessionId: "gw-123" },
    );
    expect(tip).toBe("tip");
  });

  it("returns null once the route has already moved to the tip (no loop)", () => {
    expect(
      pickTipRedirect(
        { old: "tip" },
        { taskId: "tip", restSessionId: "tip", activeSessionId: "tip" },
      ),
    ).toBeNull();
  });

  it("returns null when the active id already equals the tip", () => {
    expect(
      pickTipRedirect(
        { old: "tip" },
        { taskId: "old", restSessionId: "old", activeSessionId: "tip" },
      ),
    ).toBeNull();
  });

  it("returns null when there is no redirect for the current ids", () => {
    expect(
      pickTipRedirect({ other: "x" }, { taskId: "old", restSessionId: "old" }),
    ).toBeNull();
  });

  it("ignores empty ids", () => {
    expect(pickTipRedirect({ "": "x" }, { taskId: null, restSessionId: undefined })).toBeNull();
  });
});
