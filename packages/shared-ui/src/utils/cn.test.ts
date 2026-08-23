import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn (clsx classname merge)", () => {
  it("joins string arguments with a single space", () => {
    expect(cn("foo", "bar", "baz")).toBe("foo bar baz");
  });

  it("returns an empty string for no arguments", () => {
    expect(cn()).toBe("");
  });

  it("drops falsy primitives", () => {
    expect(cn("a", false, "b", null, "c", undefined, "d")).toBe("a b c d");
    expect(cn(0, "x")).toBe("x");
    expect(cn("", "y")).toBe("y");
    expect(cn(NaN, "z")).toBe("z");
  });

  it("keeps truthy numbers", () => {
    expect(cn(1, 2, "a")).toBe("1 2 a");
  });

  it("includes keys of object arguments whose values are truthy", () => {
    expect(cn({ foo: true }, { bar: false }, { baz: 1 }, { qux: 0 })).toBe("foo baz");
  });

  it("recursively flattens arrays", () => {
    expect(cn(["a", ["b", ["c"]], "d"])).toBe("a b c d");
  });

  it("combines objects and arrays with plain strings", () => {
    expect(cn("btn", { active: true, disabled: false }, ["md", { hovered: true }])).toBe(
      "btn active md hovered",
    );
  });

  it("handles template-literal-derived strings", () => {
    const variant = "primary";
    expect(cn(`btn-${variant}`, "btn")).toBe("btn-primary btn");
  });

  it("does not deduplicate repeated class names (clsx semantics)", () => {
    expect(cn("a", "a")).toBe("a a");
  });

  it("trims nothing and passes through whitespace-containing strings as-is", () => {
    expect(cn("  spaced  ")).toBe("  spaced  ");
  });
});
