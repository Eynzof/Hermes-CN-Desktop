// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CommandSpec } from "@/lib/commands/types";
import { useCliCommand } from "./use-cli-command";

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

describe("useCliCommand", () => {
  it("resolves a known command", () => {
    const { result } = renderHook(() => useCliCommand(), { wrapper });
    const chat = result.current.resolve("chat");
    expect(chat?.name).toBe("chat");
    expect(chat?.kind).toBe("route");
  });

  it("resolves aliases", () => {
    const { result } = renderHook(() => useCliCommand(), { wrapper });
    expect(result.current.resolve("c")?.name).toBe("chat");
    expect(result.current.resolve("history")?.name).toBe("sessions");
  });

  it("dispatches a route command by navigating", async () => {
    const { result } = renderHook(() => useCliCommand(), { wrapper });
    const chat = result.current.resolve("chat")!;
    const res = await result.current.dispatch(chat);
    expect(res.ok).toBe(true);
    expect(res.message).toContain("navigate");
  });

  it("calls registered hooks", async () => {
    const hook = vi.fn().mockResolvedValue({ value: 42 });
    const { result } = renderHook(() => useCliCommand({ hooks: { test: hook } }), { wrapper });
    const hookSpec: CommandSpec = {
      name: "test-hook",
      aliases: [],
      summary: "Test",
      kind: "hook",
      action: { type: "hook", hook: "test" },
      flags: [],
      desktopRelevant: true,
    };
    const res = await result.current.dispatch(hookSpec);
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ value: 42 });
    expect(hook).toHaveBeenCalled();
  });

  it("returns unknown command for unrecognized names", async () => {
    const { result } = renderHook(() => useCliCommand(), { wrapper });
    const res = await result.current.run("not-a-command");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("unknown command");
  });
});
