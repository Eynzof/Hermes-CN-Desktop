import { describe, expect, it, vi } from "vitest";
import { SubagentPool, type SubagentSpawnBackend } from "./pool.js";
import { runSwarm } from "./swarm.js";
import { WorktreeManager } from "./worktree.js";
import { StallMonitor } from "./stall.js";
import { AsyncDurableRunner } from "./async-durable.js";

function fakeBackend(results: Record<string, boolean>): SubagentSpawnBackend {
  return {
    execute: async (task) => ({
      ok: results[task.task] ?? true,
      agentId: task.agentId,
      task: task.task,
      output: `done:${task.task}`,
      durationMs: 1,
    }),
  };
}

describe("subagent swarm (P1-13)", () => {
  it("runs a batch with bounded concurrency and aggregates results", async () => {
    const pool = new SubagentPool(fakeBackend({ bad: false }));
    pool.register({ id: "a", name: "A" });
    pool.register({ id: "b", name: "B" });

    const summary = await runSwarm(
      pool,
      [
        { agentId: "a", task: "one" },
        { agentId: "b", task: "bad" },
        { agentId: "a", task: "three" },
      ],
      { maxConcurrency: 2 },
    );
    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.results[1].ok).toBe(false);
  });
});

describe("worktree isolation (P1-13)", () => {
  it("creates unique isolated worktrees and tracks lifecycle", () => {
    const manager = new WorktreeManager();
    const a = manager.create();
    const b = manager.create();
    expect(a.id).not.toBe(b.id);
    expect(a.path).toContain(".hermes-worktrees/");
    expect(manager.list()).toHaveLength(2);
    expect(manager.remove(a.id)).toBe(true);
    expect(manager.get(a.id)).toBeUndefined();
  });
});

describe("stall monitor (P1-13)", () => {
  it("flags tasks without recent heartbeats", () => {
    let clock = 0;
    const monitor = new StallMonitor({ thresholdMs: 100, now: () => clock });
    monitor.track("t1");
    monitor.track("t2");
    clock = 50;
    monitor.heartbeat("t2");
    clock = 150;
    expect(monitor.isStalled("t1")).toBe(true);
    expect(monitor.isStalled("t2")).toBe(false); // 150 - 50 = 100, not > threshold
    expect(monitor.stalledTaskIds()).toEqual(["t1"]);
    monitor.heartbeat("t1");
    expect(monitor.isStalled("t1")).toBe(false);
  });
});

describe("async durable runner (P1-13)", () => {
  it("executes in the background and resolves later by id", async () => {
    const runner = new AsyncDurableRunner<string>({
      executor: async (input) => `processed:${String(input)}`,
    });
    const task = runner.submit("x");
    expect(task.status).toBe("queued");
    const settled = await runner.waitFor(task.id, 2_000);
    expect(settled.status).toBe("done");
    expect(settled.result).toBe("processed:x");
  });

  it("persists task state to a storage adapter", async () => {
    const store = new Map<string, unknown>();
    const runner = new AsyncDurableRunner<string>({
      executor: async () => "ok",
      storage: {
        get: async (id) => store.get(id) as never,
        set: async (t) => { store.set(t.id, t); },
      },
    });
    const task = runner.submit("y");
    await runner.waitFor(task.id, 2_000);
    expect(store.has(task.id)).toBe(true);
    const stored = store.get(task.id) as { status: string };
    expect(stored.status).toBe("done");
  });

  it("captures failures as failed status", async () => {
    const runner = new AsyncDurableRunner<string>({
      executor: async () => { throw new Error("boom"); },
    });
    const task = runner.submit("z");
    const settled = await runner.waitFor(task.id, 2_000);
    expect(settled.status).toBe("failed");
    expect(settled.error).toBe("boom");
  });
});
