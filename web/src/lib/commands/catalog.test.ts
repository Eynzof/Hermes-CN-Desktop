import { describe, expect, it } from "vitest";
import { CLI_COMMAND_CATALOG, resolveCliCommand, desktopRelevantCommands, droppedCommandNames } from "./catalog";

describe("CLI command catalog", () => {
  it("contains the core chat/model/session/config commands", () => {
    const names = CLI_COMMAND_CATALOG.map((c) => c.name);
    expect(names).toContain("chat");
    expect(names).toContain("model");
    expect(names).toContain("sessions");
    expect(names).toContain("config");
    expect(names).toContain("project");
  });

  it("resolves aliases", () => {
    expect(resolveCliCommand("c")?.name).toBe("chat");
    expect(resolveCliCommand("models")?.name).toBe("model");
    expect(resolveCliCommand("history")?.name).toBe("sessions");
    expect(resolveCliCommand("desktop")?.name).toBe("gui");
  });

  it("returns null for unknown commands", () => {
    expect(resolveCliCommand("not-a-command")).toBeNull();
  });

  it("marks dropped messaging/networking commands", () => {
    const dropped = droppedCommandNames();
    expect(dropped).toContain("whatsapp");
    expect(dropped).toContain("slack");
    expect(dropped).toContain("proxy");
  });

  it("exposes desktop-relevant commands", () => {
    const relevant = desktopRelevantCommands();
    const names = relevant.map((c) => c.name);
    expect(names).toContain("chat");
    expect(names).toContain("project");
    expect(names).not.toContain("whatsapp");
  });

  it("does not include duplicate canonical names", () => {
    const names = CLI_COMMAND_CATALOG.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
