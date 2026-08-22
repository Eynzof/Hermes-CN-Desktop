import { describe, it, expect } from "vitest";
import {
  BlueprintLibrary,
  CronScheduler,
  CuratorEngine,
  GoalStore,
  HeartbeatLoop,
  InMemoryCronStore,
  KanbanStore,
  SubagentPool,
  createStubBackup,
  createStubCollector,
} from "@hermes/agent-core";
import {
  handleBlueprint,
  handleCron,
  handleCurator,
  handleDelegate,
  handleGoal,
  handleHeartbeat,
  handleKanban,
  handleSubgoal,
  handleSuggestions,
} from "./automation";

describe("automation slash handlers", () => {
  it("heartbeat sets and cancels", () => {
    const loop = new HeartbeatLoop(async () => {});
    const ctx = { loop, activeSessionId: "s1" };
    const set = handleHeartbeat("5m check status", ctx);
    expect(set.output).toContain("Heartbeat set");
    expect(loop.list()).toHaveLength(1);
    const cancel = handleHeartbeat("off", ctx);
    expect(cancel.output).toContain("cancelled");
  });

  it("goal and subgoal", () => {
    const store = new GoalStore();
    const ctx = { store, activeSessionId: "s1" };
    const g = handleGoal("ship v1", ctx);
    expect(g.output).toBe("Goal set: ship v1");
    const sub = handleSubgoal("write tests", ctx);
    expect(sub.output).toContain("Sub-goal added");
  });

  it("cron add/list/remove", () => {
    const store = new InMemoryCronStore();
    const scheduler = new CronScheduler(store, {
      onPrompt: async () => ({ status: "success", output: "" }),
    });
    const ctx = { scheduler, activeSessionId: "s1" };
    const add = handleCron("add @every 10m say hi", ctx);
    expect(add.output).toContain("Cron job added");
    const id = scheduler.list()[0].id;
    const list = handleCron("list", ctx);
    expect(list.output).toContain(id);
    const remove = handleCron(`remove ${id}`, ctx);
    expect(remove.output).toContain("Removed");
  });

  it("kanban creates or lists boards", () => {
    const store = new KanbanStore();
    const ctx = { store, activeSessionId: "s1" };
    const res = handleKanban("sprint", ctx);
    expect(res.output).toContain("Created kanban board");
    expect(store.list()).toHaveLength(1);
  });

  it("curator runs a snapshot", async () => {
    const engine = new CuratorEngine(createStubCollector(), createStubBackup());
    const ctx = { engine, activeSessionId: "s1" };
    const res = await handleCurator("run", ctx);
    expect(res.output).toContain("done:");
  });

  it("suggestions and blueprint surface results", () => {
    const library = new BlueprintLibrary();
    library.add("deploy", ["test", "build", "push"], ["ci"]);
    const ctx = { library, activeSessionId: "s1" };
    expect(handleSuggestions("ci", ctx).output).toContain("deploy");
    expect(handleBlueprint("deploy", ctx).output).toContain("test");
  });

  it("delegate dispatches to a subagent", async () => {
    const pool = new SubagentPool({
      execute: async (task) => ({
        ok: true,
        agentId: task.agentId,
        task: task.task,
        output: "done",
        durationMs: 0,
      }),
    });
    pool.register({ id: "coder", name: "coder" });
    const ctx = { pool, activeSessionId: "s1" };
    const res = await handleDelegate("coder refactor", ctx);
    expect(res.output).toContain("[coder] OK");
  });
});
