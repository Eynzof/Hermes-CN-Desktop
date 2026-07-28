import { describe, expect, it } from "vitest";
import { analyticsPath } from "./use-analytics";

describe("analyticsPath", () => {
  it("scopes analytics to an explicitly managed profile", () => {
    expect(analyticsPath(30, "research team"))
      .toBe("/api/analytics/usage?days=30&profile=research+team");
  });

  it("keeps the current dashboard profile behavior without an override", () => {
    expect(analyticsPath(7)).toBe("/api/analytics/usage?days=7");
  });
});
