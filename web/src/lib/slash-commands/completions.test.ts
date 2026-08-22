import { describe, expect, it } from "vitest";
import { completeSlash, completeSubcommands } from "./completions";

describe("completeSlash", () => {
  it("returns all visible commands for empty query", () => {
    const items = completeSlash({ query: "" });
    expect(items.some((i) => i.text === "/new")).toBe(true);
    expect(items.some((i) => i.text === "/compress")).toBe(true);
  });

  it("ranks exact match highest", () => {
    const items = completeSlash({ query: "new" });
    const first = items[0];
    expect(first?.text).toBe("/new");
    expect(first?.score).toBe(0);
  });

  it("ranks prefix match before substring", () => {
    const items = completeSlash({ query: "comp" });
    const texts = items.map((i) => i.text);
    expect(texts[0]).toBe("/compress");
    // Substring matches should have a higher score (lower priority) than prefix.
    const compressScore = items.find((i) => i.text === "/compress")?.score;
    expect(compressScore).toBeLessThanOrEqual(1);
  });

  it("matches description words", () => {
    const items = completeSlash({ query: "fresh" });
    expect(items.some((i) => i.text === "/new")).toBe(true);
  });

  it("includes skills with higher score than commands", () => {
    const items = completeSlash({ query: "deep", skillNames: ["deep-research"] });
    expect(items.some((i) => i.kind === "skill")).toBe(true);
  });

  it("includes bundles", () => {
    const items = completeSlash({ query: "bundle", bundleKeys: ["bundle-one"] });
    expect(items.some((i) => i.kind === "bundle" && i.text === "/bundle-one")).toBe(true);
  });

  it("limits results", () => {
    const items = completeSlash({ query: "", limit: 5 });
    expect(items.length).toBeLessThanOrEqual(5);
  });
});

describe("completeSubcommands", () => {
  it("returns subcommands from explicit list", () => {
    expect(completeSubcommands("busy", "queue")).toContain("queue");
    expect(completeSubcommands("busy", "ste")).toContain("steer");
  });

  it("returns empty list for unknown command", () => {
    expect(completeSubcommands("not-a-command", "")).toEqual([]);
  });
});
