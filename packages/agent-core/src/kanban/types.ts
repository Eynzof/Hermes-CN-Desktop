export interface KanbanWorker {
  id: string;
  name: string;
  model?: string;
}

export interface KanbanTask {
  id: string;
  title: string;
  laneId: string;
  assignee?: string;
  createdAt: number;
}

export interface KanbanLane {
  id: string;
  name: string;
  tasks: KanbanTask[];
}

export interface KanbanBoard {
  id: string;
  name: string;
  lanes: KanbanLane[];
  createdAt: number;
}
