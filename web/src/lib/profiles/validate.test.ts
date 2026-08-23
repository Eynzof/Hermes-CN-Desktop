import { describe, expect, it } from "vitest";
import { normalizeProfileName, validateProfileName } from "./validate";

describe("normalizeProfileName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeProfileName("  alpha  ")).toBe("alpha");
  });

  it("lowercases the name", () => {
    expect(normalizeProfileName("Alpha")).toBe("alpha");
    expect(normalizeProfileName("ALPHA")).toBe("alpha");
  });

  it("maps the title-cased Default to the reserved default profile", () => {
    expect(normalizeProfileName("Default")).toBe("default");
    expect(normalizeProfileName("default")).toBe("default");
    expect(normalizeProfileName("  DEFAULT ")).toBe("default");
  });

  it("keeps valid characters intact", () => {
    expect(normalizeProfileName("research-team_2")).toBe("research-team_2");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeProfileName("   ")).toBe("");
  });
});

describe("validateProfileName", () => {
  it("accepts the default profile", () => {
    expect(validateProfileName("default")).toEqual({ ok: true });
  });

  it("accepts valid lowercase names", () => {
    for (const name of ["a", "abc", "a1", "research-team", "research_team", "a-b_c1", "x".repeat(63)]) {
      expect(validateProfileName(name), `expected ${name} to be valid`).toEqual({ ok: true });
    }
  });

  it("accepts names starting with a digit", () => {
    expect(validateProfileName("1profile")).toEqual({ ok: true });
  });

  it("rejects names with illegal characters", () => {
    for (const name of ["Alpha", "a b", "a.b", "a/b", "a@b", "中文", "a\u00e9"]) {
      const result = validateProfileName(name);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("lowercase alphanumerics");
    }
  });

  it("rejects names that do not start with a letter or digit", () => {
    for (const name of ["-abc", "_abc", "-", "_"]) {
      expect(validateProfileName(name).ok).toBe(false);
    }
  });

  it("rejects empty and overlong names", () => {
    expect(validateProfileName("").ok).toBe(false);
    expect(validateProfileName("x".repeat(65)).ok).toBe(false);
    expect(validateProfileName("x".repeat(64)).ok).toBe(true); // 64 chars is the max
  });

  it("rejects reserved names", () => {
    const reserved = ["new", "list", "use", "create", "delete", "show", "alias", "rename", "export", "import", "install", "update", "info"];
    for (const name of reserved) {
      const result = validateProfileName(name);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("reserved name");
    }
  });

  it("returns an error string for invalid names", () => {
    expect(validateProfileName("UPPER")).toEqual({
      ok: false,
      error: "name must be lowercase alphanumerics, dashes or underscores, 1-64 chars",
    });
  });
});
