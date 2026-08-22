import { describe, it, expect } from "vitest";
import { CuratorEngine, createStubCollector, createStubBackup } from "./engine.js";

describe("curator/engine", () => {
  it("runs a snapshot and produces a report", async () => {
    const engine = new CuratorEngine(createStubCollector(), createStubBackup());
    const run = await engine.run("s1");
    expect(run.status).toBe("done");
    expect(run.snapshots).toHaveLength(1);
    expect(run.report).toContain("Session s1 summary");
  });
});
