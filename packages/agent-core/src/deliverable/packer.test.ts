import { describe, it, expect } from "vitest";
import { DeliverablePacker, createStubArchiveBackend } from "./packer.js";

describe("deliverable/packer", () => {
  it("collects artifacts and packs a deliverable", async () => {
    const packer = new DeliverablePacker("release", "zip", createStubArchiveBackend());
    packer.addFile("README.md", "# Release");
    packer.addFiles(["src/index.ts"]);
    const del = await packer.pack();
    expect(del.artifacts).toHaveLength(2);
    expect(del.format).toBe("zip");
  });
});
