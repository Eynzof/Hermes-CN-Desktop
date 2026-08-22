import { describe, expect, it } from "vitest";
import { BrowserSessionManager, BrowserSessionRecord } from "./index.js";

describe("BrowserSessionManager", () => {
  it("stores and retrieves sessions", () => {
    const manager = new BrowserSessionManager();
    manager.set(BrowserSessionRecord.parse({ taskId: "t1", backend: "local" }));
    expect(manager.get("t1")?.taskId).toBe("t1");
    expect(manager.list()).toHaveLength(1);
  });

  it("touches last activity", () => {
    const manager = new BrowserSessionManager();
    const record = manager.set(BrowserSessionRecord.parse({ taskId: "t1", backend: "local" }));
    const before = record.lastActiveAt;
    manager.touch("t1");
    expect(manager.get("t1")?.lastActiveAt).toBeGreaterThanOrEqual(before);
  });

  it("reaps expired sessions", () => {
    const manager = new BrowserSessionManager({ inactivityTimeoutMs: 100 });
    manager.set(BrowserSessionRecord.parse({ taskId: "t1", backend: "local", lastActiveAt: Date.now() - 200 }));
    expect(manager.expired()).toEqual(["t1"]);
  });

  it("does not reap active sessions", () => {
    const manager = new BrowserSessionManager({ inactivityTimeoutMs: 10_000 });
    manager.set(BrowserSessionRecord.parse({ taskId: "t1", backend: "local" }));
    expect(manager.expired()).toEqual([]);
  });

  it("clears all sessions", () => {
    const manager = new BrowserSessionManager();
    manager.set(BrowserSessionRecord.parse({ taskId: "t1", backend: "local" }));
    const cleared = manager.clear();
    expect(cleared).toHaveLength(1);
    expect(manager.list()).toHaveLength(0);
  });
});
