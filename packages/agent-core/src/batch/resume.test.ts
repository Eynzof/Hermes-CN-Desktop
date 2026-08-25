import { describe, expect, it, vi } from "vitest";
import { BatchRunner } from "./runner.js";

describe("batch checkpoint + resume (P1-23)", () => {
  it("captures a checkpoint and resumes remaining items", async () => {
    const handler = vi.fn(async (input: string) => ({ status: "success" as const, output: `ok:${input}` }));
    const items = [
      { id: "1", input: "a" },
      { id: "2", input: "b" },
    ];
    const runner = new BatchRunner(items, handler, { concurrency: 1, skipCompleted: false });

    // Simulate a partial run: process the first item only.
    await handler("a");
    const checkpoint = {
      jobId: runner.id,
      remainingItems: [{ id: "2", input: "b" }],
      results: [{ itemId: "1", status: "success" as const, output: "ok:a" }],
      concurrency: 1,
      progress: 50,
      completedInputs: ["a"],
    };

    const resumed = new BatchRunner(items, handler, { skipCompleted: true, resume: checkpoint });
    const job = await resumed.run();
    expect(job.results).toHaveLength(2); // prior result preserved
    expect(job.results[1].itemId).toBe("2");
    expect(job.status).toBe("done");
  });

  it("checkpoint() returns remaining items and completed inputs", async () => {
    const handler = vi.fn(async (input: string) => ({ status: "success" as const, output: `ok:${input}` }));
    const runner = new BatchRunner(
      [
        { id: "1", input: "a" },
        { id: "2", input: "b" },
      ],
      handler,
      { concurrency: 1 },
    );
    const job = await runner.run();
    const checkpoint = runner.checkpoint();
    expect(checkpoint.remainingItems).toEqual([]);
    expect(checkpoint.completedInputs).toEqual(["a", "b"]);
    expect(checkpoint.results).toHaveLength(2);
    expect(job.results).toHaveLength(2);
  });

  it("skipCompleted filters already-completed inputs on resume", async () => {
    const handler = vi.fn(async (input: string) => ({ status: "success" as const, output: `ok:${input}` }));
    const items = [
      { id: "1", input: "a" },
      { id: "2", input: "b" },
    ];
    const resumed = new BatchRunner(items, handler, {
      skipCompleted: true,
      resume: {
        jobId: "b1",
        remainingItems: items,
        results: [{ itemId: "1", status: "success", output: "ok:a" }],
        concurrency: 1,
        progress: 50,
        completedInputs: ["a"],
      },
    });
    const job = await resumed.run();
    expect(job.results).toHaveLength(2); // prior "a" + fresh "b"
    expect(handler).toHaveBeenCalledTimes(1); // only "b" re-executed
    expect(handler.mock.calls[0][0]).toBe("b");
  });
});
