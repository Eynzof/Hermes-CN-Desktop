import { describe, expect, it } from "vitest";
import { cronJobProfile } from "./use-cron";

describe("cronJobProfile", () => {
  it("prefers profile over profile_name", () => {
    expect(cronJobProfile({ profile: "alpha", profile_name: "beta" })).toBe("alpha");
  });

  it("falls back to profile_name and then default", () => {
    expect(cronJobProfile({ profile_name: "beta" })).toBe("beta");
    expect(cronJobProfile(null)).toBe("default");
  });
});
