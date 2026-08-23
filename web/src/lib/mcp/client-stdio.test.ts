import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpStdioClientTransport } from "./client-stdio";
import type { StdioTransportDeps } from "./types";

interface Listener {
  event: string;
  cb: (payload: unknown) => void;
}

function makeDeps() {
  const listeners: Listener[] = [];
  const invoke = vi.fn(async (cmd: string, args?: unknown) => {
    if (cmd === "mcp_stdio_spawn") return "child-1";
    if (cmd === "mcp_stdio_write") return undefined;
    if (cmd === "mcp_stdio_kill") return undefined;
    throw new Error(`unexpected command ${cmd}`);
  });
  const listen = vi.fn((event: string, cb: (payload: unknown) => void) => {
    listeners.push({ event, cb });
  });
  const deps: StdioTransportDeps = {
    invoke: invoke as unknown as StdioTransportDeps["invoke"],
    listen,
  };
  const emit = (event: string, payload: unknown) => {
    const entry = listeners.find((l) => l.event === event);
    if (entry) entry.cb(payload);
  };
  return { deps, invoke, listen, emit };
}

function makeTransport(deps: StdioTransportDeps): McpStdioClientTransport {
  return new McpStdioClientTransport({
    name: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "ghp_123" },
    cwd: "/tmp",
    deps,
  });
}

describe("McpStdioClientTransport", () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    ctx = makeDeps();
  });

  it("spawns the child process with the configured command/env/cwd", async () => {
    const transport = makeTransport(ctx.deps);
    await transport.start();
    expect(ctx.invoke).toHaveBeenCalledWith("mcp_stdio_spawn", {
      name: "github",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "ghp_123" },
      cwd: "/tmp",
    });
  });

  it("registers data and exit listeners for the spawned child", async () => {
    const transport = makeTransport(ctx.deps);
    await transport.start();
    expect(ctx.listen).toHaveBeenCalledWith("mcp_stdio_data:child-1", expect.any(Function));
    expect(ctx.listen).toHaveBeenCalledWith("mcp_stdio_exit:child-1", expect.any(Function));
  });

  it("delivers decoded JSON messages to onmessage", async () => {
    const transport = makeTransport(ctx.deps);
    transport.onmessage = vi.fn();
    await transport.start();
    const bytes = Array.from(new TextEncoder().encode('{"jsonrpc":"2.0","id":1}'));
    ctx.emit("mcp_stdio_data:child-1", { bytes });
    expect(transport.onmessage).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 1 });
  });

  it("delivers non-JSON payloads as raw text", async () => {
    const transport = makeTransport(ctx.deps);
    transport.onmessage = vi.fn();
    await transport.start();
    const bytes = Array.from(new TextEncoder().encode("hello from stdio"));
    ctx.emit("mcp_stdio_data:child-1", { bytes });
    expect(transport.onmessage).toHaveBeenCalledWith("hello from stdio");
  });

  it("handles multi-byte UTF-8 payloads", async () => {
    const transport = makeTransport(ctx.deps);
    transport.onmessage = vi.fn();
    await transport.start();
    const bytes = Array.from(new TextEncoder().encode('{"text":"你好"}'));
    ctx.emit("mcp_stdio_data:child-1", { bytes });
    expect(transport.onmessage).toHaveBeenCalledWith({ text: "你好" });
  });

  it("ignores payloads without a byte array or non-object payloads", async () => {
    const transport = makeTransport(ctx.deps);
    transport.onmessage = vi.fn();
    await transport.start();
    ctx.emit("mcp_stdio_data:child-1", {});
    ctx.emit("mcp_stdio_data:child-1", null);
    ctx.emit("mcp_stdio_data:child-1", { bytes: "not-an-array" });
    ctx.emit("mcp_stdio_data:child-1", { bytes: [] });
    expect(transport.onmessage).not.toHaveBeenCalled();
  });

  it("fires onclose when the child exits", async () => {
    const transport = makeTransport(ctx.deps);
    transport.onclose = vi.fn();
    await transport.start();
    ctx.emit("mcp_stdio_exit:child-1", { code: 0 });
    expect(transport.onclose).toHaveBeenCalledTimes(1);
  });

  it("send throws before start", async () => {
    const transport = makeTransport(ctx.deps);
    await expect(transport.send({ jsonrpc: "2.0", id: 1 })).rejects.toThrow(
      "MCP stdio transport not started",
    );
  });

  it("send writes newline-terminated JSON bytes to the child", async () => {
    const transport = makeTransport(ctx.deps);
    await transport.start();
    await transport.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "x" } });
    expect(ctx.invoke).toHaveBeenCalledWith("mcp_stdio_write", {
      childId: "child-1",
      bytes: expect.any(Array),
    });
    const bytes = (ctx.invoke.mock.calls[1][1] as { bytes: number[] }).bytes;
    const text = new TextDecoder().decode(Uint8Array.from(bytes));
    expect(text).toBe('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"x"}}\n');
  });

  it("close kills the child with a 5s grace window", async () => {
    const transport = makeTransport(ctx.deps);
    await transport.start();
    await transport.close();
    expect(ctx.invoke).toHaveBeenCalledWith("mcp_stdio_kill", { childId: "child-1", graceMs: 5000 });
  });

  it("close is a no-op when the transport was never started", async () => {
    const transport = makeTransport(ctx.deps);
    await expect(transport.close()).resolves.toBeUndefined();
    expect(ctx.invoke).not.toHaveBeenCalled();
  });
});
