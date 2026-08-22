import { describe, expect, it } from "vitest";
import { resolveSlashInput } from "./resolve";

describe("resolveSlashInput", () => {
  it("returns message for non-slash input", () => {
    expect(resolveSlashInput({ input: "hello" })).toEqual({ type: "message" });
  });

  it("returns message for path-like slash input", () => {
    expect(resolveSlashInput({ input: "/Users/foo.md" }).type).toBe("message");
  });

  it("resolves exact builtin command", () => {
    const intent = resolveSlashInput({ input: "/new test" });
    expect(intent.type).toBe("local");
    expect(intent.name).toBe("new");
    expect(intent.args).toBe("test");
  });

  it("resolves alias to canonical command", () => {
    const intent = resolveSlashInput({ input: "/reset" });
    expect(intent.type).toBe("local");
    expect(intent.name).toBe("new");
  });

  it("applies busy reject policy", () => {
    const intent = resolveSlashInput({ input: "/model gpt-4o", isBusy: true });
    expect(intent.type).toBe("blocked");
    expect(intent.name).toBe("model");
  });

  it("applies busy dispatch policy", () => {
    const intent = resolveSlashInput({ input: "/version", isBusy: true });
    expect(intent.type).toBe("local");
    expect(intent.name).toBe("version");
  });

  it("applies busy interrupt_then_dispatch policy", () => {
    const intent = resolveSlashInput({ input: "/new", isBusy: true });
    expect(intent.type).toBe("local");
    expect(intent.name).toBe("new");
  });

  it("resolves skill namespace", () => {
    const intent = resolveSlashInput({
      input: "/skill deep-research topic",
      skillNames: ["deep-research"],
    });
    expect(intent.type).toBe("skill");
    expect(intent.name).toBe("deep-research");
    expect(intent.args).toBe("topic");
  });

  it("resolves bare skill name", () => {
    const intent = resolveSlashInput({
      input: "/deep-research hello",
      skillNames: ["deep-research"],
    });
    expect(intent.type).toBe("skill");
    expect(intent.name).toBe("deep-research");
    expect(intent.args).toBe("hello");
  });

  it("resolves bare bundle key", () => {
    const intent = resolveSlashInput({
      input: "/my-bundle",
      bundleKeys: ["my-bundle"],
    });
    expect(intent.type).toBe("bundle");
    expect(intent.name).toBe("my-bundle");
  });

  it("resolves plugin namespaced command", () => {
    const plugins = new Map([["plugin:doit", { body: "body", description: "desc" }]]);
    const intent = resolveSlashInput({ input: "/plugin:doit arg", pluginCommands: plugins });
    expect(intent.type).toBe("plugin");
    expect(intent.name).toBe("plugin:doit");
    expect(intent.args).toBe("arg");
  });

  it("returns unique prefix match", () => {
    const intent = resolveSlashInput({ input: "/con" });
    expect(intent.type).toBe("backend");
    expect(intent.name).toBe("config");
  });

  it("returns ambiguous intent for prefix collision", () => {
    const intent = resolveSlashInput({ input: "/re" });
    expect(intent.type).toBe("invalid");
    expect(intent.candidates?.length).toBeGreaterThan(1);
  });

  it("prefers exact match over prefix collision", () => {
    // /re is ambiguous, but /retry is exact.
    const intent = resolveSlashInput({ input: "/retry" });
    expect(intent.type).toBe("local");
    expect(intent.name).toBe("retry");
  });

  it("prefers unique shortest match", () => {
    // /qui uniquely matches /quit (Exit) over hypothetical longer commands.
    const intent = resolveSlashInput({ input: "/qui" });
    expect(intent.type).toBe("backend");
    expect(intent.name).toBe("quit");
  });

  it("returns message for unknown slash input", () => {
    const intent = resolveSlashInput({ input: "/xyz-unknown" });
    expect(intent.type).toBe("message");
  });

  it("preserves alias flag on exact alias match", () => {
    const intent = resolveSlashInput({ input: "/compact" });
    expect(intent.type).toBe("local");
    expect(intent.name).toBe("compress");
    expect(intent.alias).toBe(true);
  });

  it("resolves a skill command to its parent skill", () => {
    const skillCommands = new Map([["fix", "codex"]]);
    const intent = resolveSlashInput({
      input: "/fix the types",
      skillCommandMap: skillCommands,
    });
    expect(intent.type).toBe("skill");
    expect(intent.name).toBe("codex");
    expect(intent.args).toBe("the types");
  });

  it("resolves /skill management subcommands as local", () => {
    const intent = resolveSlashInput({
      input: "/skill enable codex",
      skillNames: ["codex"],
    });
    expect(intent.type).toBe("local");
    expect(intent.name).toBe("skill");
    expect(intent.args).toBe("enable codex");
  });

  it("still resolves bare skill names before skill commands", () => {
    const skillCommands = new Map([["codex-alias", "other"]]);
    const intent = resolveSlashInput({
      input: "/codex hello",
      skillNames: ["codex"],
      skillCommandMap: skillCommands,
    });
    expect(intent.type).toBe("skill");
    expect(intent.name).toBe("codex");
  });
});
