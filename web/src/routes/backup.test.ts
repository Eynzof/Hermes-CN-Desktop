import { describe, expect, it } from "vitest";
import { containingDirectory } from "./backup";

describe("containingDirectory", () => {
  it("returns the parent folder for exported backup paths", () => {
    expect(containingDirectory("/Users/alice/Downloads/hermes-backup.zip")).toBe("/Users/alice/Downloads");
    expect(containingDirectory("C:\\Users\\alice\\Downloads\\hermes-backup.zip")).toBe("C:\\Users\\alice\\Downloads");
  });

  it("keeps filesystem roots as openable folders", () => {
    expect(containingDirectory("/hermes-backup.zip")).toBe("/");
    expect(containingDirectory("C:\\hermes-backup.zip")).toBe("C:\\");
  });
});
