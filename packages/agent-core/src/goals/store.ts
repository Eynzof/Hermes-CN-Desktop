import type { Goal, GoalStatus, SubGoal } from "./types.js";

export class GoalStore {
  private goals = new Map<string, Goal>();

  set(sessionId: string, text: string): Goal {
    const goal: Goal = {
      id: `goal-${Date.now()}`,
      sessionId,
      text,
      status: "active",
      subgoals: [],
      createdAt: Date.now(),
    };
    this.goals.set(sessionId, goal);
    return goal;
  }

  get(sessionId: string): Goal | undefined {
    const g = this.goals.get(sessionId);
    return g ? { ...g, subgoals: g.subgoals.slice() } : undefined;
  }

  addSubGoal(sessionId: string, text: string): SubGoal | undefined {
    const goal = this.goals.get(sessionId);
    if (!goal) return undefined;
    const sub: SubGoal = {
      id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      status: "active",
    };
    goal.subgoals.push(sub);
    return sub;
  }

  setStatus(sessionId: string, status: GoalStatus): boolean {
    const goal = this.goals.get(sessionId);
    if (!goal) return false;
    goal.status = status;
    return true;
  }

  completeSubGoal(sessionId: string, subGoalId: string): boolean {
    const goal = this.goals.get(sessionId);
    if (!goal) return false;
    const sub = goal.subgoals.find((s) => s.id === subGoalId);
    if (!sub) return false;
    sub.status = "completed";
    return true;
  }

  list(): Goal[] {
    return Array.from(this.goals.values()).map((g) => ({ ...g, subgoals: g.subgoals.slice() }));
  }
}
