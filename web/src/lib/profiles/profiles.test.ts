import { describe, expect, it } from "vitest";
import { getProfileHome, isDefaultProfileName, normalizeProfileName, validateProfileName } from "./index.js";

describe("profiles", () => {
  it("resolves default profile to root", () => {
    const home = getProfileHome("/home/user/.hermes", "default");
    expect(home.isDefault).toBe(true);
    expect(home.root).toBe("/home/user/.hermes");
  });

  it("resolves named profile under profiles root", () => {
    const home = getProfileHome("/home/user/.hermes", "work");
    expect(home.isDefault).toBe(false);
    expect(home.root).toContain("profiles");
  });

  it("normalizes names", () => {
    expect(normalizeProfileName("Default")).toBe("default");
    expect(normalizeProfileName("MyProfile")).toBe("myprofile");
  });

  it("validates profile names", () => {
    expect(validateProfileName("default").ok).toBe(true);
    expect(validateProfileName("bad name").ok).toBe(false);
    expect(validateProfileName("create").ok).toBe(false);
  });
});
