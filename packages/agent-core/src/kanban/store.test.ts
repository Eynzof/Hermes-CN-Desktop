import { describe, it, expect } from "vitest";
import { KanbanStore } from "./store.js";

describe("kanban/store", () => {
  it("creates a board and manages tasks", () => {
    const store = new KanbanStore();
    const board = store.createBoard("sprint", ["backlog", "doing", "done"]);
    const task = store.addTask(board.id, "write tests", "backlog")!;
    expect(task.title).toBe("write tests");

    expect(store.moveTask(board.id, task.id, "doing")).toBe(true);
    store.registerWorker({ id: "ralph", name: "Ralph" });
    expect(store.assignWorker(board.id, task.id, "ralph")).toBe(true);

    const status = store.status(board.id);
    expect(status.counts["doing"]).toBe(1);
  });
});
