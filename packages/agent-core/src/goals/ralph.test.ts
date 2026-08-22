import { describe, it, expect } from "vitest";
import { GoalStore } from "./store.js";
import { RalphLoop } from "./ralph.js";

describe("goals/ralph", () => {
  it("waits when no goal", async () => {
    const store = new GoalStore();
    const loop = new RalphLoop(store, { shouldProceed: async () => true });
    const res = await loop.tick("s1");
    expect(res.action).toBe("none");
  });

  it("proceeds when gate passes", async () => {
    const store = new GoalStore();
    store.set("s1", "x");
    const loop = new RalphLoop(store, { shouldProceed: async () => true });
    const res = await loop.tick("s1");
    expect(res.action).toBe("proceed");
  });
});
