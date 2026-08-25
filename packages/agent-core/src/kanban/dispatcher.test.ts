import { describe, expect, it } from "vitest";
import { KanbanStore } from "./store.js";
import { KanbanDispatcher } from "./dispatcher.js";

function setup(overrides: Partial<import("./dispatcher.js").KanbanDispatcherOptions> = {}) {
  const store = new KanbanStore();
  let clock = 1_000;
  const dispatcher = new KanbanDispatcher({
    store,
    claimTtlMs: 100,
    circuitBreakerThreshold: 2,
    circuitBreakerCooldownMs: 500,
    now: () => clock,
    ...overrides,
  });
  return { store, dispatcher, tick: (ms: number) => { clock += ms; } };
}

describe("kanban dispatcher (P1-12)", () => {
  it("claims the oldest available task in the worker's lane", () => {
    const { store, dispatcher } = setup();
    const board = store.createBoard("b1");
    store.addTask(board.id, "first");
    store.addTask(board.id, "second");

    const claimed = dispatcher.claimNext("w1");
    expect(claimed?.title).toBe("first");
    // Second claim returns the next unclaimed task.
    expect(dispatcher.claimNext("w1")?.title).toBe("second");
    // Nothing left to claim.
    expect(dispatcher.claimNext("w1")).toBeUndefined();
  });

  it("respects worker lane restriction", () => {
    const { store, dispatcher } = setup({
      laneForWorker: (workerId) => (workerId === "w-review" ? "review" : undefined),
    });
    const board = store.createBoard("b1", ["todo", "review", "done"]);
    store.addTask(board.id, "needs-review", "review");
    store.addTask(board.id, "plain", "todo");

    const review = dispatcher.claimNext("w-review");
    expect(review?.title).toBe("needs-review");
    expect(dispatcher.claimNext("w-general")?.title).toBe("plain");
  });

  it("reclaims expired claims via reap (claim TTL)", () => {
    const { store, dispatcher, tick } = setup();
    const board = store.createBoard("b1");
    store.addTask(board.id, "slow");
    const task = dispatcher.claimNext("w1")!;
    expect(task.title).toBe("slow");

    tick(150); // past 100ms TTL
    expect(dispatcher.reap()).toContain(task.id);
    // Now claimable by another worker.
    expect(dispatcher.claimNext("w2")?.title).toBe("slow");
  });

  it("heartbeat extends a live claim", () => {
    const { store, dispatcher, tick } = setup();
    const board = store.createBoard("b1");
    store.addTask(board.id, "long");
    const task = dispatcher.claimNext("w1")!;

    tick(90);
    expect(dispatcher.heartbeat("w1")).toBe(1);
    tick(90); // still within the extended TTL window
    expect(dispatcher.reap()).not.toContain(task.id);
  });

  it("complete moves the task to done and releases the claim", () => {
    const { store, dispatcher } = setup();
    const board = store.createBoard("b1");
    store.addTask(board.id, "t");
    const task = dispatcher.claimNext("w1")!;
    expect(dispatcher.complete(task.id, "w1")).toBe(true);
    const done = store.get(board.id)!.lanes.find((l) => l.id === "done")!;
    expect(done.tasks.map((t) => t.id)).toContain(task.id);
    expect(dispatcher.claimNext("w1")).toBeUndefined();
  });

  it("trips the circuit breaker after repeated failures and cools down", () => {
    const { store, dispatcher, tick } = setup();
    const board = store.createBoard("b1");

    store.addTask(board.id, "t1");
    const first = dispatcher.claimNext("w1")!;
    dispatcher.fail(first.id, "w1");
    expect(dispatcher.workerStatus("w1").failures).toBe(1);
    expect(dispatcher.workerStatus("w1").tripped).toBe(false);

    // The failed task is claimable again; failing it twice trips the breaker.
    const second = dispatcher.claimNext("w1")!;
    expect(second.id).toBe(first.id);
    dispatcher.fail(second.id, "w1");
    expect(dispatcher.workerStatus("w1").tripped).toBe(true);

    store.addTask(board.id, "t2");
    expect(dispatcher.claimNext("w1")).toBeUndefined(); // tripped → no claims

    tick(600); // past cooldown
    // Oldest claimable task is available again once the breaker cools down.
    expect(dispatcher.claimNext("w1")?.title).toBe("t1");
    expect(dispatcher.claimNext("w1")?.title).toBe("t2");
  });

  it("assignee tasks are only claimable by their worker", () => {
    const { store, dispatcher } = setup();
    const board = store.createBoard("b1");
    const task = store.addTask(board.id, "assigned");
    store.assignWorker(board.id, task!.id, "w1");

    expect(dispatcher.claimNext("w2")).toBeUndefined();
    expect(dispatcher.claimNext("w1")?.title).toBe("assigned");
  });
});
