import { describe, expect, it } from "vitest";
import {
  COMMAND_REGISTRY,
  allSubcommands,
  commandCategories,
  commandNames,
  gatewayHelpLines,
  getSubcommands,
  isDesktopVisible,
  listCommands,
  resolveAlias,
  resolveCommand,
} from "./registry";

describe("COMMAND_REGISTRY", () => {
  it("contains desktop-relevant commands", () => {
    const names = commandNames();
    expect(names).toContain("new");
    expect(names).toContain("reset");
    expect(names).toContain("compress");
    expect(names).toContain("compact");
    expect(names).toContain("model");
    expect(names).toContain("help");
    expect(names).toContain("version");
  });

  it("has no duplicate canonical names", () => {
    const seen = new Set<string>();
    for (const cmd of COMMAND_REGISTRY) {
      expect(seen.has(cmd.name)).toBe(false);
      seen.add(cmd.name);
    }
  });

  it("resolves commands case-insensitively and strips slashes", () => {
    expect(resolveCommand("new")?.name).toBe("new");
    expect(resolveCommand("/NEW")?.name).toBe("new");
    expect(resolveCommand("  /reset ")?.name).toBe("new");
  });

  it("resolves aliases to canonical names", () => {
    expect(resolveAlias("compact")).toBe("compress");
    expect(resolveAlias("q")).toBe("queue");
    expect(resolveAlias("switch")).toBe("sessions");
  });

  it("returns undefined for unknown commands", () => {
    expect(resolveCommand("not-a-command")).toBeUndefined();
  });

  it("lists commands with aliases", () => {
    const names = commandNames();
    expect(names.filter((n) => n === "new").length).toBe(1);
    expect(names).toContain("reset");
  });

  it("hides gateway-only commands from desktop help", () => {
    const help = gatewayHelpLines();
    const names = help.map((h) => h.name);
    expect(names).toContain("/new");
    expect(names).not.toContain("/kick");
    expect(names).not.toContain("/platforms");
  });

  it("hides cli-only commands from desktop help", () => {
    const help = gatewayHelpLines();
    const names = help.map((h) => h.name);
    expect(names).not.toContain("/plugins");
    expect(names).not.toContain("/browser");
  });

  it("includes hidden commands when requested", () => {
    const help = gatewayHelpLines({ includeHidden: true });
    const names = help.map((h) => h.name);
    expect(names).toContain("/kick");
    expect(names).toContain("/plugins");
  });

  it("returns categories in registry order without duplicates", () => {
    const cats = commandCategories();
    const unique = new Set(cats);
    expect(cats.length).toBe(unique.size);
    expect(cats).toContain("Session");
    expect(cats).toContain("Configuration");
    expect(cats).toContain("Tools & Skills");
    expect(cats).toContain("Info");
  });

  it("extracts subcommands from explicit and pipe-hint argsHint", () => {
    expect(getSubcommands("busy")).toContain("queue");
    expect(getSubcommands("busy")).toContain("steer");
    expect(getSubcommands("busy")).toContain("interrupt");
    expect(getSubcommands("busy")).toContain("status");
    expect(allSubcommands().length).toBeGreaterThan(0);
  });

  it("marks most non-local commands with a backendUntil plan", () => {
    const moa = resolveCommand("moa");
    expect(moa?.backendUntil).toBe("mixture-of-agents");
    // /skills has been migrated to a local handler; non-local commands still need
    // a backendUntil plan.
    const skills = resolveCommand("skills");
    expect(skills?.local).toBe("skills");
    expect(skills?.backendUntil).toBeUndefined();
  });

  it("exposes desktop-visible helper correctly", () => {
    const newCmd = resolveCommand("new")!;
    expect(isDesktopVisible(newCmd)).toBe(true);
    const kick = resolveCommand("kick")!;
    expect(isDesktopVisible(kick)).toBe(false);
  });
});
