import { describe, expect, it, vi } from "vitest";
import { LocalBrowserProvider } from "./local.js";
import { BrowserConfig, BrowserBackendKind, BrowserSessionRecord } from "../schemas.js";
import type { BrowserInvoker } from "../tool-handlers.js";

const config = BrowserConfig.parse({});
const session: BrowserSessionRecord = BrowserSessionRecord.parse({
  taskId: "task-1",
  backend: BrowserBackendKind.Enum.local,
  sessionName: "local-task-1",
});

function makeInvoker(results?: Record<string, unknown>) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const invoke: BrowserInvoker = vi.fn(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (results && command in results) return results[command];
    return { success: true };
  });
  return { invoke, calls };
}

describe("LocalBrowserProvider", () => {
  it("exposes its identity and is always available", async () => {
    const provider = new LocalBrowserProvider();
    expect(provider.name).toBe("local");
    expect(provider.displayName).toBe("Local Browser (CDP / agent-browser)");
    await expect(provider.isAvailable(config)).resolves.toBe(true);
  });

  it("createSession forwards start args and passes through cdpUrl/sessionName", async () => {
    const { invoke, calls } = makeInvoker({
      browser_sidecar_start: { cdpUrl: "ws://127.0.0.1:9222", sessionName: "sess-1" },
    });
    const provider = new LocalBrowserProvider({ invoke });
    const result = await provider.createSession("task-7", BrowserConfig.parse({ headed: true }));
    expect(result).toEqual({
      taskId: "task-7",
      backend: BrowserBackendKind.Enum.local,
      cdpUrl: "ws://127.0.0.1:9222",
      sessionName: "sess-1",
    });
    expect(calls).toEqual([
      {
        command: "browser_sidecar_start",
        args: { taskId: "task-7", engine: "chromium", headed: true, recordSessions: false },
      },
    ]);
  });

  it("createSession defaults sessionName to local-<taskId>", async () => {
    const { invoke } = makeInvoker({ browser_sidecar_start: {} });
    const provider = new LocalBrowserProvider({ invoke });
    const result = await provider.createSession("task-1", config);
    expect(result.sessionName).toBe("local-task-1");
    expect(result.cdpUrl).toBeUndefined();
  });

  it("closeSession stops the sidecar for the task", async () => {
    const { invoke, calls } = makeInvoker();
    const provider = new LocalBrowserProvider({ invoke });
    await provider.closeSession(session);
    expect(calls).toEqual([{ command: "browser_sidecar_stop", args: { taskId: "task-1" } }]);
  });

  it("emergencyCleanup stops all sidecars with the emergency flag", async () => {
    const { invoke, calls } = makeInvoker();
    const provider = new LocalBrowserProvider({ invoke });
    await provider.emergencyCleanup();
    expect(calls).toEqual([
      { command: "browser_sidecar_stop", args: { taskId: "*", emergency: true } },
    ]);
  });

  it("navigate forwards the normalized URL and timeout", async () => {
    const { invoke, calls } = makeInvoker({ browser_navigate: { success: true, url: "https://example.com/", title: "Ex" } });
    const provider = new LocalBrowserProvider({ invoke });
    const result = await provider.navigate(session, "  https://example.com  ", 15);
    expect(result).toMatchObject({ success: true, title: "Ex" });
    expect(calls).toEqual([
      {
        command: "browser_navigate",
        args: { taskId: "task-1", url: "https://example.com/", timeout: 15 },
      },
    ]);
  });

  it("navigate rejects private/loopback URLs via the SSRF guard", async () => {
    const { invoke } = makeInvoker();
    const provider = new LocalBrowserProvider({ invoke });
    await expect(provider.navigate(session, "http://127.0.0.1:8080/admin")).rejects.toThrow(
      "Unsafe URL",
    );
    await expect(provider.navigate(session, "http://localhost:3000")).rejects.toThrow(
      "Unsafe URL",
    );
    await expect(provider.navigate(session, "file:///etc/passwd")).rejects.toThrow("Unsafe URL");
  });

  it("maps every operation to its sidecar command and args", async () => {
    const { invoke, calls } = makeInvoker();
    const provider = new LocalBrowserProvider({ invoke });

    await provider.snapshot(session, true);
    expect(calls.at(-1)).toEqual({
      command: "browser_snapshot",
      args: { taskId: "task-1", full: true },
    });

    await provider.click(session, "@e1");
    expect(calls.at(-1)).toEqual({ command: "browser_click", args: { taskId: "task-1", ref: "@e1" } });

    await provider.type(session, "@e2", "hello", true);
    expect(calls.at(-1)).toEqual({
      command: "browser_type",
      args: { taskId: "task-1", ref: "@e2", text: "hello", submit: true },
    });

    await provider.scroll(session, "down", 200);
    expect(calls.at(-1)).toEqual({
      command: "browser_scroll",
      args: { taskId: "task-1", direction: "down", amount: 200 },
    });

    await provider.back(session);
    expect(calls.at(-1)).toEqual({ command: "browser_back", args: { taskId: "task-1" } });

    await provider.press(session, "Enter");
    expect(calls.at(-1)).toEqual({ command: "browser_press", args: { taskId: "task-1", key: "Enter" } });

    await provider.console(session, "1+1", false);
    expect(calls.at(-1)).toEqual({
      command: "browser_console",
      args: { taskId: "task-1", expression: "1+1", clear: false },
    });
  });

  it("passes operation results through untouched", async () => {
    const payload = { success: true, snapshot: "<html>", url: "https://example.com" };
    const { invoke } = makeInvoker({ browser_navigate: payload });
    const provider = new LocalBrowserProvider({ invoke });
    await expect(provider.navigate(session, "https://example.com")).resolves.toEqual(payload);
  });

  it("returns an error result when no invoker is configured", async () => {
    const provider = new LocalBrowserProvider();
    const result = await provider.navigate(session, "https://example.com");
    expect(result).toEqual({
      success: false,
      error: "No local browser sidecar invoker configured",
    });
  });

  it("propagates invoker rejections", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("sidecar crashed");
    });
    const provider = new LocalBrowserProvider({ invoke });
    await expect(provider.createSession("t", config)).rejects.toThrow("sidecar crashed");
  });
});
