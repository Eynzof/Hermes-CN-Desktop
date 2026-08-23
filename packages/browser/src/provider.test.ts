import { describe, expect, it } from "vitest";
import type { BrowserOperationResult, BrowserProvider, CreateSessionResult } from "./provider.js";
import { BrowserBackendKind, BrowserSessionRecord } from "./schemas.js";

/**
 * Provider abstraction contract tests. `provider.ts` is an interface module;
 * these tests lock the shape of the contract that `registry.ts`,
 * `tool-handlers.ts` and the backends implement.
 */
describe("browser provider contract", () => {
  it("CreateSessionResult accepts the full optional surface", () => {
    const result: CreateSessionResult = {
      taskId: "task-1",
      backend: BrowserBackendKind.Enum.browserbase,
      sessionName: "bb-task-1",
      bbSessionId: "bb-id",
      cdpUrl: "ws://cdp",
      expiresAt: "2025-01-01T00:00:00Z",
      features: { proxies: true },
      externalCallId: "call-1",
    };
    expect(result.backend).toBe("browserbase");
    expect(result.externalCallId).toBe("call-1");
  });

  it("CreateSessionResult works with the minimal shape", () => {
    const result: CreateSessionResult = {
      taskId: "task-2",
      backend: BrowserBackendKind.Enum.local,
    };
    expect(result.sessionName).toBeUndefined();
    expect(result.features).toBeUndefined();
  });

  it("BrowserOperationResult accepts success and optional payload fields", () => {
    const ok: BrowserOperationResult = {
      success: true,
      url: "https://example.com",
      title: "Example",
      snapshot: "<html>",
      console: [{ type: "log", text: "hi" }],
      pendingDialogs: [{ id: "d1" }],
      frameTree: { frames: [] },
    };
    expect(ok.success).toBe(true);
    const err: BrowserOperationResult = { success: false, error: "boom" };
    expect(err.error).toBe("boom");
  });

  it("a full backend satisfies the optional operation surface", async () => {
    const calls: string[] = [];
    const provider: BrowserProvider = {
      name: BrowserBackendKind.Enum.local,
      displayName: "Full",
      isAvailable: async () => true,
      createSession: async (taskId) => {
        calls.push("createSession");
        return { taskId, backend: provider.name };
      },
      closeSession: async () => {
        calls.push("closeSession");
      },
      emergencyCleanup: async () => {
        calls.push("emergencyCleanup");
      },
      navigate: async () => {
        calls.push("navigate");
        return { success: true };
      },
      snapshot: async () => {
        calls.push("snapshot");
        return { success: true };
      },
      click: async () => {
        calls.push("click");
        return { success: true };
      },
      type: async () => {
        calls.push("type");
        return { success: true };
      },
      scroll: async () => {
        calls.push("scroll");
        return { success: true };
      },
      back: async () => {
        calls.push("back");
        return { success: true };
      },
      press: async () => {
        calls.push("press");
        return { success: true };
      },
      console: async () => {
        calls.push("console");
        return { success: true };
      },
    };

    const session = BrowserSessionRecord.parse({ taskId: "t", backend: provider.name });
    await provider.createSession("t", {} as never);
    await provider.closeSession(session);
    await provider.emergencyCleanup();
    await provider.navigate?.(session, "https://example.com");
    await provider.snapshot?.(session);
    await provider.click?.(session, "@e");
    await provider.type?.(session, "@e", "hi");
    await provider.scroll?.(session, "down");
    await provider.back?.(session);
    await provider.press?.(session, "Enter");
    await provider.console?.(session);
    expect(calls).toEqual([
      "createSession",
      "closeSession",
      "emergencyCleanup",
      "navigate",
      "snapshot",
      "click",
      "type",
      "scroll",
      "back",
      "press",
      "console",
    ]);
  });

  it("a minimal cloud backend may omit all optional operations", () => {
    const provider: BrowserProvider = {
      name: BrowserBackendKind.Enum.firecrawl,
      displayName: "Minimal",
      isAvailable: () => false,
      createSession: async (taskId) => ({ taskId, backend: provider.name }),
      closeSession: async () => {},
      emergencyCleanup: async () => {},
    };
    expect("navigate" in provider).toBe(false);
    expect("type" in provider).toBe(false);
    expect(typeof provider.isAvailable).toBe("function");
  });
});
