import { describe, it, expect } from "vitest";
import { GoalStore } from "./store.js";

describe("goals/store", () => {
  it("sets a goal and adds subgoals", () => {
    const store = new GoalStore();
    const goal = store.set("s1", "ship release");
    expect(goal.text).toBe("ship release");

    const sub = store.addSubGoal("s1", "write changelog")!;
    expect(sub.text).toBe("write changelog");

    store.completeSubGoal("s1", sub.id);
    expect(store.get("s1")?.subgoals[0].status).toBe("completed");
  });
});
