import { describe, it, expect } from "vitest";
import { BlueprintLibrary, levenshtein } from "./blueprint.js";

describe("automation/blueprint", () => {
  it("adds and matches blueprints", () => {
    const lib = new BlueprintLibrary();
    lib.add("nightly backup", ["stop services", "rsync", "restart"], ["backup"]);
    lib.add("deploy", ["test", "build", "push"], ["ci"]);
    expect(lib.match("backup")).toHaveLength(1);
    expect(lib.list()).toHaveLength(2);
  });

  it("computes levenshtein distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
  });
});
