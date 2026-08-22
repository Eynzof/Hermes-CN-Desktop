import { describe, expect, it, vi } from "vitest";
import { dispatchCommand, dispatchCliCommand } from "./dispatch";
import type { CommandSpec } from "./types";

const routeSpec: CommandSpec = {
  name: "chat",
  aliases: [],
  summary: "Chat",
  kind: "route",
  action: { type: "navigate", to: "/" },
  flags: [],
  desktopRelevant: true,
};

const hookSpec: CommandSpec = {
  name: "test-hook",
  aliases: [],
  summary: "Test hook",
  kind: "hook",
  action: { type: "hook", hook: "test" },
  flags: [],
  desktopRelevant: true,
};

const noneSpec: CommandSpec = {
  name: "noop",
  aliases: [],
  summary: "Noop",
  kind: "palette-only",
  action: { type: "none" },
  flags: [],
  desktopRelevant: true,
};

describe("dispatchCommand", () => {
  it("navigates for route actions", async () => {
    const navigate = vi.fn();
    const result = await dispatchCommand(routeSpec, { navigate });
    expect(result.ok).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("fails route actions when navigate is missing", async () => {
    const result = await dispatchCommand(routeSpec);
    expect(result.ok).toBe(false);
  });

  it("calls registered hooks", async () => {
    const hook = vi.fn().mockResolvedValue({ value: 42 });
    const result = await dispatchCommand(hookSpec, { hooks: { test: hook } });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ value: 42 });
  });

  it("fails when hook is not registered", async () => {
    const result = await dispatchCommand(hookSpec);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("hook not registered");
  });

  it("returns no-op for palette-only commands", async () => {
    const result = await dispatchCommand(noneSpec);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("no-op");
  });
});

describe("dispatchCliCommand", () => {
  it("resolves and dispatches by name", async () => {
    const navigate = vi.fn();
    const result = await dispatchCliCommand("chat", {
      resolve: (name) => (name === "chat" ? routeSpec : null),
      navigate,
    });
    expect(result.ok).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("returns unknown command for unresolved names", async () => {
    const result = await dispatchCliCommand("missing", { resolve: () => null });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("unknown command");
  });
});
