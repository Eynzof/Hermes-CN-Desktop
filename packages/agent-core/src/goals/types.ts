export type GoalStatus = "active" | "paused" | "completed";

export interface SubGoal {
  id: string;
  text: string;
  status: GoalStatus;
}

export interface Goal {
  id: string;
  sessionId: string;
  text: string;
  status: GoalStatus;
  subgoals: SubGoal[];
  createdAt: number;
}
