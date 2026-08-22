import { describe, it, expect } from "vitest";
import { BatchRunner } from "./runner.js";

describe("batch/runner", () => {
  it("runs all items with bounded concurrency", async () => {
    const items = [
      { id: "a", input: "1" },
      { id: "b", input: "2" },
      { id: "c", input: "3" },
    ];
    let maxConcurrent = 0;
    let active = 0;
    const runner = new BatchRunner(
      items,
      async (input) => {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { status: "success", output: `out-${input}` };
      },
      { concurrency: 2 },
    );

    const job = await runner.run();
    expect(job.status).toBe("done");
    expect(job.results).toHaveLength(3);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
