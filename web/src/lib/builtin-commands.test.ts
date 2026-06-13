import { describe, expect, it } from "vitest";
import {
  filterBuiltinCommands,
  isBuiltinComposerCommandToken,
  parseBuiltinComposerCommand,
} from "./builtin-commands";

describe("parseBuiltinComposerCommand", () => {
  it("matches /compress with no argument", () => {
    expect(parseBuiltinComposerCommand("/compress")).toEqual({ name: "compress", arg: "" });
  });

  it("captures a focus topic argument", () => {
    expect(parseBuiltinComposerCommand("/compress keep the auth thread")).toEqual({
      name: "compress",
      arg: "keep the auth thread",
    });
  });

  it("treats /compact as an alias for compress", () => {
    expect(parseBuiltinComposerCommand("/compact")).toEqual({ name: "compress", arg: "" });
  });

  it("is case-insensitive and tolerates leading whitespace", () => {
    expect(parseBuiltinComposerCommand("  /COMPRESS  ")).toEqual({ name: "compress", arg: "" });
  });

  it("ignores commands that only share a prefix", () => {
    expect(parseBuiltinComposerCommand("/compressed now")).toBeNull();
  });

  it("ignores slashes that are not at the start", () => {
    expect(parseBuiltinComposerCommand("please run /compress")).toBeNull();
  });

  it("ignores unknown commands and plain text", () => {
    expect(parseBuiltinComposerCommand("/status")).toBeNull();
    expect(parseBuiltinComposerCommand("hello world")).toBeNull();
  });
});

describe("isBuiltinComposerCommandToken", () => {
  it("recognises exact built-in tokens with or without the slash", () => {
    expect(isBuiltinComposerCommandToken("/compress")).toBe(true);
    expect(isBuiltinComposerCommandToken("compress")).toBe(true);
    expect(isBuiltinComposerCommandToken("/compact")).toBe(true);
  });

  it("does not recognise partial input or other commands", () => {
    expect(isBuiltinComposerCommandToken("/comp")).toBe(false);
    expect(isBuiltinComposerCommandToken("/status")).toBe(false);
  });
});

describe("filterBuiltinCommands", () => {
  it("lists every built-in command for an empty query", () => {
    const all = filterBuiltinCommands("");
    expect(all.map((c) => c.command)).toEqual(["/compress"]);
  });

  it("matches a partial prefix of the command name", () => {
    expect(filterBuiltinCommands("comp").map((c) => c.name)).toEqual(["compress"]);
    expect(filterBuiltinCommands("compa").map((c) => c.name)).toEqual(["compress"]);
  });

  it("matches via an alias prefix", () => {
    // "compact" is an alias of compress
    expect(filterBuiltinCommands("compact").map((c) => c.name)).toEqual(["compress"]);
  });

  it("returns nothing for an unrelated query", () => {
    expect(filterBuiltinCommands("deploy")).toEqual([]);
  });
});
