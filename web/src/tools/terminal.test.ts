import { describe, expect, it, vi, beforeEach } from "vitest";
import { terminalTool } from "./terminal";
import { setFakeTerminalBackend, setTerminalManager } from "@/services/terminal/terminalManager";
import type { TerminalBackend } from "@/services/terminal/types";

describe("terminal tool", () => {
  let outputHandler: ((event: { terminalId: string; data?: string; exitCode?: number }) => void) | null = null;

  const fakeBackend: TerminalBackend = {
    async start() {
      return { id: "term-tool-1", shell: "bash" };
    },
    async write() {},
    async resize() {},
    async kill() {},
    onOutput(handler) {
      outputHandler = handler;
      return vi.fn();
    },
  };

  beforeEach(() => {
    outputHandler = null;
    setTerminalManager(null);
    setFakeTerminalBackend(fakeBackend);
  });

  it("starts a background session", async () => {
    const result = await terminalTool({ command: "sleep 5", background: true });
    expect(result.status).toBe("ok");
    expect(result.session_id).toBe("term-tool-1");
  });

  it("matches a pattern in foreground output", async () => {
    const promise = terminalTool({ command: "echo ready", wait_for_pattern: "ready", timeout: 2 });
    // Give the tool time to start and begin waiting.
    await new Promise((r) => setTimeout(r, 50));
    expect(outputHandler).not.toBeNull();
    outputHandler!({ terminalId: "term-tool-1", data: "ready\n" });
    const result = await promise;
    expect(result.status).toBe("ok");
    expect(result.wait_matched).toBe(true);
    expect(result.matched_pattern).toBe("ready");
  });

  it("promotes on timeout when requested", async () => {
    const promise = terminalTool({ command: "sleep 10", timeout: 0.1, promote_on_timeout: true });
    const result = await promise;
    expect(result.status).toBe("promoted");
    expect(result.session_id).toBe("term-tool-1");
  });

  it("normalizes mode aliases", async () => {
    const result = await terminalTool({ command: "ls", mode: "bg" as const, background: true });
    expect(result.status).toBe("ok");
  });
});
