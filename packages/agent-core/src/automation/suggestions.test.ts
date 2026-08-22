import { describe, it, expect } from "vitest";
import { BlueprintLibrary } from "./blueprint.js";
import { generateSuggestions } from "./suggestions.js";

describe("automation/suggestions", () => {
  it("generates suggestions for a topic", () => {
    const lib = new BlueprintLibrary();
    lib.add("deploy", ["test", "build", "push"], ["ci"]);
    const suggestions = generateSuggestions("ci", lib.list());
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].title).toContain("deploy");
  });
});
