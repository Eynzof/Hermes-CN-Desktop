import { describe, expect, it } from "vitest";
import { shouldPrewarmDraftSession } from "./draft-session-prewarm";

describe("shouldPrewarmDraftSession", () => {
  it("keeps first-message prewarm for the desktop-managed runtime", () => {
    expect(shouldPrewarmDraftSession("managed")).toBe(true);
  });

  it("does not warm user-managed local or remote Hermes instances on page open", () => {
    expect(shouldPrewarmDraftSession("local")).toBe(false);
    expect(shouldPrewarmDraftSession("remote")).toBe(false);
  });

  it("fails closed until the desktop runtime mode is known", () => {
    expect(shouldPrewarmDraftSession(undefined)).toBe(false);
  });
});
