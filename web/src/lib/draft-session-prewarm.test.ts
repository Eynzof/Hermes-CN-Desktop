import { describe, expect, it } from "vitest";
import {
  draftSessionMatches,
  shouldPrewarmDraftSession,
} from "./draft-session-prewarm";

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

  it("reuses a draft only for the same workspace and model route", () => {
    const draft = {
      cwd: " C:/work/project ",
      model: "deepseek-v4-flash",
      provider: "deepseek",
    };
    expect(draftSessionMatches(draft, {
      cwd: "C:/work/project",
      model: "deepseek-v4-flash",
      provider: "deepseek",
    })).toBe(true);
    expect(draftSessionMatches(draft, {
      cwd: "C:/work/project",
      model: "deepseek-v4-pro",
      provider: "deepseek",
    })).toBe(false);
  });
});
