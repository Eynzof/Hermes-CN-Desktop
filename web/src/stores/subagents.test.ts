import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "jotai";
import type { GatewayEvent } from "@hermes/protocol";
import {
  __resetNativeSubagentSessions,
  activeSubagentCount,
  buildSubagentTree,
  clearFinishedSubagentsAtom,
  delegateTaskPayloads,
  dropFinishedSubagents,
  flattenSubagents,
  idOf,
  markUnfinishedInterrupted,
  pruneDelegateFallback,
  reduceSubagentList,
  routeSubagentGatewayEventAtom,
  subagentsBySessionAtom,
  type SubagentPayload,
  type SubagentProgress,
} from "./subagents";

const NOW = 1_700_000_000_000;

function progress(over: Partial<SubagentProgress>): SubagentProgress {
  return {
    id: "x",
    parentId: null,
    goal: "goal",
    status: "running",
    taskCount: 1,
    taskIndex: 0,
    startedAt: NOW,
    updatedAt: NOW,
    filesRead: [],
    filesWritten: [],
    stream: [],
    ...over,
  };
}

function event(type: string, sessionId: string, payload: SubagentPayload): GatewayEvent {
  return { type, session_id: sessionId, payload } as GatewayEvent;
}

describe("idOf", () => {
  it("prefers subagent_id", () => {
    expect(idOf({ subagent_id: "sa-1", parent_id: "p", task_index: 2, goal: "g" })).toBe("sa-1");
  });

  it("falls back to parent:taskIndex:goal", () => {
    expect(idOf({ parent_id: "p", task_index: 2, goal: "g" })).toBe("p:2:g");
  });

  it("uses 'root' when no parent", () => {
    expect(idOf({ task_index: 0, goal: "g" })).toBe("root:0:g");
  });
});

describe("reduceSubagentList", () => {
  it("creates an entry when createIfMissing", () => {
    const next = reduceSubagentList([], { subagent_id: "a", goal: "Build" }, true, "subagent.start", NOW);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: "a", goal: "Build", status: "running" });
  });

  it("no-ops when missing and createIfMissing is false", () => {
    const list: SubagentProgress[] = [];
    const next = reduceSubagentList(list, { subagent_id: "a", goal: "x" }, false, "subagent.progress", NOW);
    expect(next).toBe(list);
  });

  it("updates an existing entry and applies terminal status + summary", () => {
    const start = reduceSubagentList([], { subagent_id: "a", goal: "x" }, true, "subagent.start", NOW);
    const done = reduceSubagentList(
      start,
      { subagent_id: "a", status: "completed", summary: "done!", duration_seconds: 3, output_tokens: 12 },
      false,
      "subagent.complete",
      NOW + 5,
    );
    expect(done[0]).toMatchObject({ id: "a", status: "completed", summary: "done!", durationSeconds: 3, outputTokens: 12 });
    expect(done[0]!.startedAt).toBe(NOW); // preserved across updates
  });

  it("freezes terminal subagents against late events", () => {
    const done = reduceSubagentList([], { subagent_id: "a", goal: "x", status: "completed" }, true, "subagent.complete", NOW);
    const late = reduceSubagentList(done, { subagent_id: "a", status: "running" }, false, "subagent.progress", NOW + 9);
    expect(late).toBe(done);
    expect(late[0]!.status).toBe("completed");
  });
});

describe("buildSubagentTree", () => {
  it("nests children under parents and sorts roots by startedAt", () => {
    const items: SubagentProgress[] = [
      progress({ id: "child", parentId: "root-b", goal: "child", startedAt: NOW + 30 }),
      progress({ id: "root-b", parentId: null, goal: "b", startedAt: NOW + 20 }),
      progress({ id: "root-a", parentId: null, goal: "a", startedAt: NOW + 10 }),
    ];
    const tree = buildSubagentTree(items);
    expect(tree.map((n) => n.id)).toEqual(["root-a", "root-b"]);
    expect(tree[1]!.children.map((n) => n.id)).toEqual(["child"]);
    expect(flattenSubagents(tree).map((n) => n.id)).toEqual(["root-a", "root-b", "child"]);
  });
});

describe("delegateTaskPayloads", () => {
  it("returns [] for non-delegate tools", () => {
    expect(delegateTaskPayloads({ name: "bash" }, "running", "tool.start")).toEqual([]);
  });

  it("splits tasks into rows with delegate-tool ids and running status", () => {
    const payload: SubagentPayload = {
      name: "delegate_task",
      tool_id: "t1",
      args: { tasks: [{ goal: "A" }, { goal: "B" }] },
    };
    const rows = delegateTaskPayloads(payload, "running", "tool.start");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ subagent_id: "delegate-tool:t1:0", goal: "A", status: "running", task_count: 2 });
    expect(rows[1]!.subagent_id).toBe("delegate-tool:t1:1");
  });

  it("marks completed (or failed) on the complete phase", () => {
    const ok = delegateTaskPayloads({ name: "delegate_task", tool_id: "t", context: "C" }, "complete", "tool.complete");
    expect(ok[0]).toMatchObject({ status: "completed", subagent_id: "delegate-tool:t:0" });
    const failed = delegateTaskPayloads({ name: "delegate_task", tool_id: "t", error: "boom" }, "complete", "tool.complete");
    expect(failed[0]!.status).toBe("failed");
  });
});

describe("pruneDelegateFallback / activeSubagentCount", () => {
  it("drops delegate-tool rows only", () => {
    const list = [progress({ id: "delegate-tool:t:0" }), progress({ id: "native-1" })];
    expect(pruneDelegateFallback(list).map((n) => n.id)).toEqual(["native-1"]);
  });

  it("returns the same ref when nothing to prune", () => {
    const list = [progress({ id: "native-1" })];
    expect(pruneDelegateFallback(list)).toBe(list);
  });

  it("counts running and queued", () => {
    const list = [
      progress({ id: "1", status: "running" }),
      progress({ id: "2", status: "queued" }),
      progress({ id: "3", status: "completed" }),
    ];
    expect(activeSubagentCount(list)).toBe(2);
  });

  it("markUnfinishedInterrupted flips only non-terminal rows (same ref when none)", () => {
    const done = [progress({ id: "1", status: "completed" })];
    expect(markUnfinishedInterrupted(done)).toBe(done);
    const mixed = [progress({ id: "1", status: "running" }), progress({ id: "2", status: "failed" })];
    expect(markUnfinishedInterrupted(mixed).map((n) => n.status)).toEqual(["interrupted", "failed"]);
  });

  it("dropFinishedSubagents keeps running/queued only (same ref when nothing to drop)", () => {
    const activeOnly = [progress({ id: "1", status: "running" })];
    expect(dropFinishedSubagents(activeOnly)).toBe(activeOnly);
    const mixed = [
      progress({ id: "1", status: "running" }),
      progress({ id: "2", status: "completed" }),
      progress({ id: "3", status: "queued" }),
    ];
    expect(dropFinishedSubagents(mixed).map((n) => n.id)).toEqual(["1", "3"]);
  });
});

describe("routeSubagentGatewayEventAtom", () => {
  beforeEach(() => {
    __resetNativeSubagentSessions();
  });

  it("ingests native subagent.start under the session_id", () => {
    const store = createStore();
    store.set(routeSubagentGatewayEventAtom, event("subagent.start", "s1", { subagent_id: "a", goal: "Build" }), NOW);
    expect(store.get(subagentsBySessionAtom).s1).toHaveLength(1);
    expect(store.get(subagentsBySessionAtom).s1![0]).toMatchObject({ id: "a", goal: "Build" });
  });

  it("keeps finished rows across turns; unfinished rows become interrupted on message.start", () => {
    const store = createStore();
    store.set(
      routeSubagentGatewayEventAtom,
      event("subagent.start", "s1", { subagent_id: "done", goal: "g" }),
      NOW,
    );
    store.set(
      routeSubagentGatewayEventAtom,
      event("subagent.complete", "s1", { subagent_id: "done", status: "completed" }),
      NOW + 1,
    );
    store.set(
      routeSubagentGatewayEventAtom,
      event("subagent.start", "s1", { subagent_id: "hanging", goal: "g2" }),
      NOW + 2,
    );
    store.set(routeSubagentGatewayEventAtom, event("message.start", "s1", {}), NOW + 3);

    const list = store.get(subagentsBySessionAtom).s1!;
    expect(list.map((n) => [n.id, n.status])).toEqual([
      ["done", "completed"],
      ["hanging", "interrupted"],
    ]);
  });

  it("clearFinishedSubagentsAtom drops terminal rows only", () => {
    const store = createStore();
    store.set(routeSubagentGatewayEventAtom, event("subagent.start", "s1", { subagent_id: "a", goal: "g" }), NOW);
    store.set(
      routeSubagentGatewayEventAtom,
      event("subagent.complete", "s1", { subagent_id: "a", status: "completed" }),
      NOW + 1,
    );
    store.set(routeSubagentGatewayEventAtom, event("subagent.start", "s1", { subagent_id: "b", goal: "g2" }), NOW + 2);

    store.set(clearFinishedSubagentsAtom, ["s1", undefined, "missing"]);
    expect(store.get(subagentsBySessionAtom).s1!.map((n) => n.id)).toEqual(["b"]);
  });

  it("synthesizes delegate fallback rows, then prunes them when native events arrive", () => {
    const store = createStore();
    store.set(
      routeSubagentGatewayEventAtom,
      event("tool.start", "s1", { name: "delegate_task", tool_id: "t", args: { tasks: [{ goal: "A" }] } }),
      NOW,
    );
    expect(store.get(subagentsBySessionAtom).s1!.map((n) => n.id)).toEqual(["delegate-tool:t:0"]);

    store.set(routeSubagentGatewayEventAtom, event("subagent.start", "s1", { subagent_id: "native", goal: "Native" }), NOW + 1);
    expect(store.get(subagentsBySessionAtom).s1!.map((n) => n.id)).toEqual(["native"]);
  });

  it("ignores delegate fallback once a session has gone native", () => {
    const store = createStore();
    store.set(routeSubagentGatewayEventAtom, event("subagent.start", "s1", { subagent_id: "native", goal: "g" }), NOW);
    store.set(
      routeSubagentGatewayEventAtom,
      event("tool.start", "s1", { name: "delegate_task", tool_id: "t", args: { tasks: [{ goal: "A" }] } }),
      NOW + 1,
    );
    expect(store.get(subagentsBySessionAtom).s1!.map((n) => n.id)).toEqual(["native"]);
  });
});
