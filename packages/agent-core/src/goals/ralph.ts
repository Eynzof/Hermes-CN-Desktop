import type { GoalStore } from "./store.js";

export interface RalphJudge {
  shouldProceed(sessionId: string, goalText: string): Promise<boolean>;
}

export class RalphLoop {
  private store: GoalStore;
  private judge: RalphJudge;

  constructor(store: GoalStore, judge: RalphJudge) {
    this.store = store;
    this.judge = judge;
  }

  async tick(sessionId: string): Promise<{ action: "proceed" | "wait" | "none"; reason: string }> {
    const goal = this.store.get(sessionId);
    if (!goal) return { action: "none", reason: "No active goal" };
    if (goal.status === "paused") return { action: "wait", reason: "Goal is paused" };
    const ok = await this.judge.shouldProceed(sessionId, goal.text);
    return ok
      ? { action: "proceed", reason: "Gate passed" }
      : { action: "wait", reason: "Gate not passed" };
  }
}
