import type { KanbanBoard, KanbanLane, KanbanTask, KanbanWorker } from "./types.js";

export class KanbanStore {
  private boards = new Map<string, KanbanBoard>();
  private workers = new Map<string, KanbanWorker>();

  createBoard(name: string, lanes: string[] = ["todo", "doing", "done"]): KanbanBoard {
    const board: KanbanBoard = {
      id: `board-${Date.now()}`,
      name,
      lanes: lanes.map((n) => ({ id: n, name: n, tasks: [] })),
      createdAt: Date.now(),
    };
    this.boards.set(board.id, board);
    return board;
  }

  list(): KanbanBoard[] {
    return Array.from(this.boards.values());
  }

  get(id: string): KanbanBoard | undefined {
    return this.boards.get(id);
  }

  addTask(boardId: string, title: string, laneId?: string): KanbanTask | undefined {
    const board = this.boards.get(boardId);
    if (!board) return undefined;
    const lane = board.lanes.find((l) => l.id === laneId) ?? board.lanes[0];
    if (!lane) return undefined;
    const task: KanbanTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      laneId: lane.id,
      createdAt: Date.now(),
    };
    lane.tasks.push(task);
    return task;
  }

  moveTask(boardId: string, taskId: string, laneId: string): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;
    const dest = board.lanes.find((l) => l.id === laneId);
    if (!dest) return false;
    let moved: KanbanTask | undefined;
    for (const lane of board.lanes) {
      const idx = lane.tasks.findIndex((t) => t.id === taskId);
      if (idx >= 0) {
        moved = lane.tasks.splice(idx, 1)[0];
        break;
      }
    }
    if (!moved) return false;
    moved.laneId = laneId;
    dest.tasks.push(moved);
    return true;
  }

  assignWorker(boardId: string, taskId: string, workerId: string): boolean {
    const board = this.boards.get(boardId);
    const worker = this.workers.get(workerId) ?? { id: workerId, name: workerId };
    if (!board) return false;
    for (const lane of board.lanes) {
      const task = lane.tasks.find((t) => t.id === taskId);
      if (task) {
        task.assignee = worker.name;
        return true;
      }
    }
    return false;
  }

  registerWorker(worker: KanbanWorker): void {
    this.workers.set(worker.id, worker);
  }

  status(boardId: string): { board?: KanbanBoard; counts: Record<string, number> } {
    const board = this.boards.get(boardId);
    const counts: Record<string, number> = {};
    for (const lane of board?.lanes ?? []) {
      counts[lane.name] = lane.tasks.length;
    }
    return { board, counts };
  }
}
