import { describe, it, expect } from "vitest";
import { SubagentPool } from "./pool.js";
import { delegateTask } from "./dispatch.js";
import type { SubagentTask, SubagentResult } from "./types.js";

describe("subagent/delegation", () => {
  it("delegates a task to a registered subagent", async () => {
    const pool = new SubagentPool({
      execute: async (task: SubagentTask): Promise<SubagentResult> => ({
        ok: true,
        agentId: task.agentId,
        task: task.task,
        output: "done",
        durationMs: 12,
      }),
    });
    pool.register({ id: "coder", name: "coder", model: "gpt-4o" });

    const result = await delegateTask(pool, { agent: "coder", task: "refactor utils" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("done");
  });

  it("returns error for unknown agent", async () => {
    const pool = new SubagentPool({
      execute: async (task: SubagentTask): Promise<SubagentResult> => ({
        ok: true,
        agentId: task.agentId,
        task: task.task,
        output: "",
        durationMs: 0,
      }),
    });
    const result = await delegateTask(pool, { agent: "ghost", task: "x" });
    expect(result.ok).toBe(false);
  });
});
