import { describe, expect, it } from "vitest";
import { importProfile } from "./import";

describe("importProfile", () => {
  it("resolves the imported profile home for a named profile", async () => {
    await expect(importProfile("/tmp/archive.tar.gz", "research")).resolves.toEqual({
      name: "research",
      root: "~/.hermes/profiles/research",
    });
  });

  it("returns a fresh object per call", async () => {
    const first = await importProfile("/tmp/a.tar.gz", "p1");
    const second = await importProfile("/tmp/a.tar.gz", "p1");
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("propagates the requested name verbatim", async () => {
    const result = await importProfile("/tmp/x.tar.gz", "team-alpha_2");
    expect(result.name).toBe("team-alpha_2");
    expect(result.root).toBe("~/.hermes/profiles/team-alpha_2");
  });

  it("is async so the Rust import command can be awaited", () => {
    const promise = importProfile("/tmp/x.tar.gz", "p");
    expect(promise).toBeInstanceOf(Promise);
  });
});
