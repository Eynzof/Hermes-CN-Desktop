import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SLASH_COMMANDS, SlashDispatcher } from "./slash.js";

function ctx(overrides: Partial<Parameters<SlashDispatcher["dispatch"]>[0]> = {}) {
  return {
    platform: "telegram",
    chatId: "c1",
    userId: "u1",
    command: "status",
    args: "",
    isAdmin: false,
    ...overrides,
  };
}

describe("DEFAULT_SLASH_COMMANDS", () => {
  it("registers the documented command set", () => {
    const names = DEFAULT_SLASH_COMMANDS.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["new", "reset", "status", "whoami", "stop", "help", "approve", "deny"]),
    );
  });

  it("marks approve/deny as admin-only", () => {
    const approve = DEFAULT_SLASH_COMMANDS.find((c) => c.name === "approve");
    const deny = DEFAULT_SLASH_COMMANDS.find((c) => c.name === "deny");
    expect(approve?.adminOnly).toBe(true);
    expect(deny?.adminOnly).toBe(true);
    expect(DEFAULT_SLASH_COMMANDS.find((c) => c.name === "help")?.adminOnly).toBeUndefined();
  });

  it("defines every command with a description and handler", () => {
    for (const cmd of DEFAULT_SLASH_COMMANDS) {
      expect(cmd.description.length).toBeGreaterThan(0);
      expect(typeof cmd.handler).toBe("function");
    }
  });
});

describe("SlashDispatcher", () => {
  it("dispatches registered commands with context", async () => {
    const dispatcher = new SlashDispatcher();
    const result = await dispatcher.dispatch(ctx());
    expect(result).toBe("Status for telegram: ok");
  });

  it("passes args and user identity through to handlers", async () => {
    const handler = vi.fn(async () => "handled");
    const dispatcher = new SlashDispatcher([{ name: "echo", description: "e", handler }]);
    await dispatcher.dispatch(ctx({ command: "echo", args: "hello world", userId: "u9" }));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ command: "echo", args: "hello world", userId: "u9" }),
    );
  });

  it("resolves aliases to the canonical command", async () => {
    const dispatcher = new SlashDispatcher([
      {
        name: "status",
        aliases: ["st"],
        description: "s",
        handler: async (c) => `ok:${c.command}`,
      },
    ]);
    expect(await dispatcher.dispatch(ctx({ command: "st" }))).toBe("ok:status");
  });

  it("returns an unknown-command message for unregistered commands", async () => {
    const dispatcher = new SlashDispatcher([]);
    expect(await dispatcher.dispatch(ctx({ command: "nope" }))).toBe("Unknown command: /nope");
  });

  it("gates admin-only commands for non-admin users", async () => {
    const dispatcher = new SlashDispatcher();
    expect(await dispatcher.dispatch(ctx({ command: "approve", isAdmin: false }))).toBe("Admin only.");
  });

  it("runs admin-only commands for admins", async () => {
    const dispatcher = new SlashDispatcher();
    expect(await dispatcher.dispatch(ctx({ command: "deny", isAdmin: true }))).toBe("Denied.");
  });

  it("register overrides an existing command by name", async () => {
    const dispatcher = new SlashDispatcher();
    dispatcher.register({
      name: "status",
      description: "custom",
      handler: async () => "custom status",
    });
    expect(await dispatcher.dispatch(ctx())).toBe("custom status");
  });

  it("supports async handlers and rejects propagate", async () => {
    const dispatcher = new SlashDispatcher([
      {
        name: "fail",
        description: "f",
        handler: async () => {
          throw new Error("handler error");
        },
      },
    ]);
    await expect(dispatcher.dispatch(ctx({ command: "fail" }))).rejects.toThrow("handler error");
  });

  it("list returns unique commands (aliases share the canonical object)", () => {
    const dispatcher = new SlashDispatcher([
      { name: "a", aliases: ["b"], description: "d", handler: async () => "x" },
    ]);
    const names = dispatcher.list().map((c) => c.name);
    expect(names).toEqual(["a"]);
    expect(dispatcher.list()).toHaveLength(1);
  });

  it("constructor with no arguments loads the default commands", () => {
    const dispatcher = new SlashDispatcher();
    expect(dispatcher.list().map((c) => c.name)).toEqual(
      expect.arrayContaining(DEFAULT_SLASH_COMMANDS.map((c) => c.name)),
    );
  });
});
