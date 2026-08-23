import { describe, expect, it, vi } from "vitest";
import { SubagentPool } from "./pool.js";
import type { SubagentResult, SubagentTask } from "./types.js";

const okResult = async (task: SubagentTask): Promise<SubagentResult> => ({
  ok: true,
  agentId: task.agentId,
  task: task.task,
  output: "done",
  durationMs: 12,
});

describe("SubagentPool", () => {
  it("starts with no registered agents", () => {
    const pool = new SubagentPool({ execute: okResult });
    expect(pool.list()).toEqual([]);
  });

  it("register adds a config and list returns it", () => {
    const pool = new SubagentPool({ execute: okResult });
    pool.register({ id: "coder", name: "Coder", model: "gpt-4o", instructions: "be brief" });
    expect(pool.list()).toHaveLength(1);
    expect(pool.list()[0]).toMatchObject({ id: "coder", name: "Coder", model: "gpt-4o" });
  });

  it("register overwrites a config with the same id", () => {
    const pool = new SubagentPool({ execute: okResult });
    pool.register({ id: "coder", name: "old", model: "gpt-4o" });
    pool.register({ id: "coder", name: "new", model: "gpt-4o-mini" });
    expect(pool.list()).toHaveLength(1);
    expect(pool.list()[0]).toMatchObject({ name: "new", model: "gpt-4o-mini" });
  });

  it("resolve finds a config by id", () => {
    const pool = new SubagentPool({ execute: okResult });
    pool.register({ id: "coder", name: "Coder" });
    expect(pool.resolve("coder")?.id).toBe("coder");
  });

  it("resolve finds a config by name when the id is not present", () => {
    const pool = new SubagentPool({ execute: okResult });
    pool.register({ id: "coder", name: "code-reviewer" });
    expect(pool.resolve("code-reviewer")?.id).toBe("coder");
  });

  it("resolve prefers id over a name collision", () => {
    const pool = new SubagentPool({ execute: okResult });
    // "shared" is both an id (agent A) and a name (agent B).
    pool.register({ id: "shared", name: "agent-a" });
    pool.register({ id: "agent-b", name: "shared" });
    expect(pool.resolve("shared")?.id).toBe("shared");
    expect(pool.resolve("agent-a")?.id).toBe("shared");
    expect(pool.resolve("agent-b")?.id).toBe("agent-b");
  });

  it("resolve returns undefined for an unknown id and name", () => {
    const pool = new SubagentPool({ execute: okResult });
    pool.register({ id: "coder", name: "Coder" });
    expect(pool.resolve("ghost")).toBeUndefined();
    expect(pool.resolve("unknown-name")).toBeUndefined();
  });

  it("dispatch returns an error result for an unknown agent without calling the backend", async () => {
    const execute = vi.fn(okResult);
    const pool = new SubagentPool({ execute });
    const result = await pool.dispatch({ agentId: "ghost", task: "x" });

    expect(result.ok).toBe(false);
    expect(result.agentId).toBe("ghost");
    expect(result.task).toBe("x");
    expect(result.output).toBe("Unknown subagent: ghost");
    expect(result.durationMs).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("dispatch resolves by name and canonicalizes agentId to the registered id", async () => {
    const execute = vi.fn(okResult);
    const pool = new SubagentPool({ execute });
    pool.register({ id: "coder", name: "code-reviewer", model: "gpt-4o", instructions: "be brief" });

    const result = await pool.dispatch({
      agentId: "code-reviewer",
      task: "review the diff",
      context: "extra context",
      timeout: 30,
    });

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    const received = execute.mock.calls[0][0];
    expect(received.agentId).toBe("coder");
    expect(received.task).toBe("review the diff");
    expect(received.context).toBe("extra context");
    expect(received.timeout).toBe(30);
  });

  it("dispatch passes the task through unchanged when the id matches directly", async () => {
    const execute = vi.fn(okResult);
    const pool = new SubagentPool({ execute });
    pool.register({ id: "coder", name: "Coder" });

    const result = await pool.dispatch({ agentId: "coder", task: "t" });

    expect(result.ok).toBe(true);
    expect(execute.mock.calls[0][0]).toEqual({ agentId: "coder", task: "t" });
  });

  it("dispatch returns the backend result verbatim", async () => {
    const result: SubagentResult = {
      ok: true,
      agentId: "coder",
      task: "t",
      output: "backend output",
      durationMs: 42,
    };
    const pool = new SubagentPool({ execute: async () => result });
    pool.register({ id: "coder", name: "Coder" });
    await expect(pool.dispatch({ agentId: "coder", task: "t" })).resolves.toBe(result);
  });

  it("dispatch propagates backend failures", async () => {
    const boom = new Error("backend exploded");
    const pool = new SubagentPool({
      execute: async () => {
        throw boom;
      },
    });
    pool.register({ id: "coder", name: "Coder" });
    await expect(pool.dispatch({ agentId: "coder", task: "t" })).rejects.toThrow("backend exploded");
  });
});
