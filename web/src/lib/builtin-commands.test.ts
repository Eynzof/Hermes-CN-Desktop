import { describe, expect, it } from "vitest";
import {
  filterComposerCommands,
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

  it("does not treat the /skill namespace opener as a built-in command", () => {
    // else the palette would close when "/skill" is fully typed.
    expect(isBuiltinComposerCommandToken("/skill")).toBe(false);
    expect(isBuiltinComposerCommandToken("skill")).toBe(false);
  });
});

describe("filterComposerCommands", () => {
  it("lists /compress only when no skill picker is available", () => {
    expect(filterComposerCommands("").map((c) => c.command)).toEqual(["/compress"]);
  });

  it("includes the /skill namespace command when skills are available", () => {
    const all = filterComposerCommands("", { skillsAvailable: true });
    expect(all.map((c) => c.command)).toEqual(["/skill", "/compress"]);
    expect(all.find((c) => c.command === "/skill")).toMatchObject({
      token: "skill",
      kind: "namespace",
    });
  });

  it("matches a partial prefix of the command name", () => {
    expect(filterComposerCommands("comp").map((c) => c.token)).toEqual(["compress"]);
    expect(filterComposerCommands("sk", { skillsAvailable: true }).map((c) => c.token)).toEqual([
      "skill",
    ]);
  });

  it("matches /compress via the /compact alias prefix", () => {
    expect(filterComposerCommands("compact").map((c) => c.token)).toEqual(["compress"]);
  });

  it("returns nothing for an unrelated query", () => {
    expect(filterComposerCommands("deploy", { skillsAvailable: true })).toEqual([]);
  });
});
