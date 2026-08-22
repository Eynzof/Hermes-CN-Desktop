import { describe, expect, it } from "vitest";
import { TerminalWaitService } from "./waitService";
import type { TerminalSession } from "./types";

function makeSession(buffer = "", status = "running"): TerminalSession {
  return {
    id: "t1",
    command: "cmd",
    status: status as TerminalSession["status"],
    exitCode: null,
    outputBuffer: buffer,
    bufferOverflowed: false,
    scanCursor: 0,
    completionPromise: Promise.resolve(),
    completionResolve: () => {},
    startedAt: Date.now(),
    shell: "bash",
    detached: false,
    completionConsumed: false,
  };
}

describe("TerminalWaitService", () => {
  const service = new TerminalWaitService();

  it("matches a pattern in new output", async () => {
    const session = makeSession();
    const promise = service.wait(session, { pattern: "ready", timeout: 2 });
    session.outputBuffer = "initial\nready> ";
    const result = await promise;
    expect(result.status).toBe("matched");
    expect(result.matchedPattern).toBe("ready");
  });

  it("returns output immediately when no pattern", async () => {
    const session = makeSession();
    const promise = service.wait(session, { timeout: 2 });
    session.outputBuffer = "hello";
    const result = await promise;
    expect(result.status).toBe("output");
    expect(result.output).toBe("hello");
  });

  it("returns only new output after sinceChars", async () => {
    const session = makeSession("first");
    const promise = service.wait(session, { pattern: "second", sinceChars: 5, timeout: 2 });
    session.outputBuffer = "first second";
    const result = await promise;
    expect(result.output).toBe(" second");
    expect(result.status).toBe("matched");
  });

  it("respects abort signal", async () => {
    const session = makeSession();
    const controller = new AbortController();
    const promise = service.wait(session, { timeout: 5 }, controller.signal);
    controller.abort();
    const result = await promise;
    expect(result.status).toBe("interrupted");
  });

  it("returns error for invalid regex", async () => {
    const session = makeSession();
    const result = await service.wait(session, { pattern: "[invalid", timeout: 1 });
    expect(result.status).toBe("error");
    expect(result.hint).toBe("Invalid regex pattern");
  });

  it("times out when no new output", async () => {
    const session = makeSession();
    const result = await service.wait(session, { timeout: 0.1 });
    expect(result.status).toBe("timeout");
  });

  it("detects exited session", async () => {
    const session = makeSession("done", "exited");
    const result = await service.wait(session, { timeout: 2 });
    expect(result.status).toBe("exited");
  });
});
