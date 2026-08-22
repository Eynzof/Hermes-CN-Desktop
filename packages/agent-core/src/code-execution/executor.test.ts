import { describe, it, expect } from "vitest";
import { CodeExecutor, createStubExecutor } from "./executor.js";

describe("code-execution/executor", () => {
  it("creates and runs a job", async () => {
    const executor = new CodeExecutor(createStubExecutor());
    const job = executor.createJob("print(1)", "python", 10);
    const result = await executor.run(job);
    expect(result.status).toBe("success");
    expect(result.stdout).toContain("python");
    expect(executor.status(job.id)?.jobId).toBe(job.id);
  });
});
