import { describe, it, expect, vi } from "vitest";
import { McpConnectionManager } from "./connection-manager.js";
import type { McpServerConfig, McpTransport } from "./types.js";

class FakeTransport implements McpTransport {
  sent: unknown[] = [];
  started = false;
  closed = false;
  onmessage?: (msg: unknown) => void;
  onclose?: () => void;
  onerror?: (err: Error) => void;

  async start(): Promise<void> {
    this.started = true;
  }
  async send(message: unknown): Promise<void> {
    this.sent.push(message);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("McpConnectionManager", () => {
  it("upserts and connects a server", async () => {
    const transports = new Map<string, FakeTransport>();
    const manager = new McpConnectionManager({
      createTransport: (name) => {
        const t = new FakeTransport();
        transports.set(name, t);
        return t;
      },
    });
    const cfg: McpServerConfig = { name: "test", transport: "stdio", command: "echo", enabled: true };
    manager.upsert(cfg);
    expect(manager.snapshot()).toHaveLength(1);
    const result = await manager.connect("test");
    expect(result.ok).toBe(true);
    expect(transports.get("test")?.started).toBe(true);
    expect(transports.get("test")?.sent.length).toBe(1);
  });

  it("removes a server and closes transport", async () => {
    const transports = new Map<string, FakeTransport>();
    const manager = new McpConnectionManager({
      createTransport: (name) => {
        const t = new FakeTransport();
        transports.set(name, t);
        return t;
      },
    });
    manager.upsert({ name: "x", transport: "stdio", enabled: true });
    await manager.connect("x");
    manager.remove("x");
    expect(transports.get("x")?.closed).toBe(true);
    expect(manager.snapshot()).toHaveLength(0);
  });

  it("counts tools from initialize response", async () => {
    const transports = new Map<string, FakeTransport>();
    const manager = new McpConnectionManager({
      createTransport: (name) => {
        const t = new FakeTransport();
        transports.set(name, t);
        return t;
      },
    });
    manager.upsert({ name: "y", transport: "stdio", enabled: true });
    const p = manager.connect("y");
    const t = transports.get("y")!;
    t.onmessage?.({ jsonrpc: "2.0", id: "init", result: { tools: [{ name: "a" }, { name: "b" }] } });
    await p;
    expect(manager.snapshot()[0].toolCount).toBe(2);
  });

  it("emits status changes", async () => {
    const manager = new McpConnectionManager({ createTransport: () => new FakeTransport() });
    const cb = vi.fn();
    manager.onStatusChange(cb);
    manager.upsert({ name: "z", transport: "stdio", enabled: true });
    expect(cb).toHaveBeenCalled();
  });
});
