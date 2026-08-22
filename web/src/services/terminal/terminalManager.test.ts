import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalManager, setFakeTerminalBackend, setTerminalManager } from "./terminalManager";
import type { TerminalBackend } from "./types";

describe("TerminalManager", () => {
  let outputHandler: ((event: { terminalId: string; data?: string; exitCode?: number }) => void) | null = null;

  const fakeBackend: TerminalBackend = {
    async start(options) {
      return { id: "term-1", shell: options.mode === "interactive" ? "bash" : "cmd" };
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

  it("creates and retrieves a session", async () => {
    const manager = new TerminalManager(fakeBackend);
    const id = await manager.start({ command: "echo hi" });
    const session = manager.get(id);
    expect(session).toBeDefined();
    expect(session?.command).toBe("echo hi");
    expect(session?.status).toBe("running");
  });

  it("tracks rolling output window and overflow flag via backend events", async () => {
    const manager = new TerminalManager(fakeBackend);
    await manager.start({ command: "echo hi" });
    expect(outputHandler).not.toBeNull();
    outputHandler!({ terminalId: "term-1", data: "line1\n" });
    outputHandler!({ terminalId: "term-1", data: "line2\n" });

    const session = manager.get("term-1")!;
    expect(session.outputBuffer).toBe("line1\nline2\n");
    expect(session.bufferOverflowed).toBe(false);
  });

  it("promotes a session", async () => {
    const manager = new TerminalManager(fakeBackend);
    await manager.start({ command: "cmd" });
    manager.promoteSession("term-1");
    const session = manager.get("term-1")!;
    expect(session.status).toBe("promoted");
    expect(session.detached).toBe(true);
  });

  it("poll returns lines from offset", async () => {
    const manager = new TerminalManager(fakeBackend);
    await manager.start({ command: "cmd" });
    outputHandler!({ terminalId: "term-1", data: "a\nb\nc\n" });
    const result = manager.poll("term-1", 1);
    expect(result.lines).toEqual(["b", "c", ""]);
    expect(result.totalLines).toBe(4);
  });
});
