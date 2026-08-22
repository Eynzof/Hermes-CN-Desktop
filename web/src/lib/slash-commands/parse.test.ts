import { describe, expect, it } from "vitest";
import { parseSlashInput } from "./parse";

describe("parseSlashInput", () => {
  it("parses a bare command", () => {
    expect(parseSlashInput("/new")).toEqual({ name: "new", args: "", namespaced: false });
  });

  it("parses a command with arguments", () => {
    expect(parseSlashInput("/new My Session")).toEqual({
      name: "new",
      args: "My Session",
      namespaced: false,
    });
  });

  it("is case-insensitive", () => {
    expect(parseSlashInput("/NEW")).toEqual({ name: "new", args: "", namespaced: false });
  });

  it("trims leading whitespace", () => {
    expect(parseSlashInput("   /compress auth")).toEqual({
      name: "compress",
      args: "auth",
      namespaced: false,
    });
  });

  it("rejects plain text", () => {
    expect(parseSlashInput("hello world")).toBeNull();
  });

  it("rejects slashes not at the start", () => {
    expect(parseSlashInput("hello /compress")).toBeNull();
  });

  it("rejects path-like names", () => {
    expect(parseSlashInput("/Users/foo.md")).toBeNull();
    expect(parseSlashInput("/some/path")).toBeNull();
  });

  it("allows plugin: namespaced commands", () => {
    expect(parseSlashInput("/plugin:doit arg1")).toEqual({
      name: "doit",
      args: "arg1",
      namespaced: true,
      namespace: "plugin",
    });
  });

  it("allows skill: namespaced commands", () => {
    expect(parseSlashInput("/skill:research deep")).toEqual({
      name: "research",
      args: "deep",
      namespaced: true,
      namespace: "skill",
    });
  });

  it("rejects namespaced names with slashes", () => {
    expect(parseSlashInput("/plugin:foo/bar")).toBeNull();
  });

  it("rejects empty namespace or name", () => {
    expect(parseSlashInput("/:foo")).toBeNull();
    expect(parseSlashInput("/plugin:")).toBeNull();
  });
});
