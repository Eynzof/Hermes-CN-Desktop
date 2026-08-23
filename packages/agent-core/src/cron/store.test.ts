import { describe, expect, it } from "vitest";
import { InMemoryCronStore } from "./store.js";
import type { CronJob, CronRun } from "./types.js";

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    schedule: "@every 1m",
    prompt: "say hi",
    enabled: true,
    createdAt: 1000,
    runCount: 0,
    ...overrides,
  };
}

function makeRun(overrides: Partial<CronRun> = {}): CronRun {
  return {
    jobId: "job-1",
    startedAt: 2000,
    status: "success",
    output: "ok",
    ...overrides,
  };
}

describe("InMemoryCronStore", () => {
  it("starts empty", () => {
    const store = new InMemoryCronStore();
    expect(store.list()).toEqual([]);
  });

  it("put stores a job and get returns it", () => {
    const store = new InMemoryCronStore();
    const job = makeJob();
    store.put(job);
    expect(store.get("job-1")).toBe(job);
  });

  it("get returns undefined for a missing id", () => {
    const store = new InMemoryCronStore();
    expect(store.get("missing")).toBeUndefined();
  });

  it("list returns jobs sorted by createdAt, not insertion order", () => {
    const store = new InMemoryCronStore();
    store.put(makeJob({ id: "b", createdAt: 3000 }));
    store.put(makeJob({ id: "a", createdAt: 1000 }));
    store.put(makeJob({ id: "c", createdAt: 2000 }));
    expect(store.list().map((j) => j.id)).toEqual(["a", "c", "b"]);
  });

  it("put overwrites an existing job with the same id", () => {
    const store = new InMemoryCronStore();
    store.put(makeJob({ prompt: "original" }));
    store.put(makeJob({ prompt: "updated", enabled: false }));
    expect(store.list()).toHaveLength(1);
    expect(store.get("job-1")?.prompt).toBe("updated");
    expect(store.get("job-1")?.enabled).toBe(false);
  });

  it("remove deletes a job and reports whether it existed", () => {
    const store = new InMemoryCronStore();
    expect(store.remove("job-1")).toBe(false);
    store.put(makeJob());
    expect(store.remove("job-1")).toBe(true);
    expect(store.get("job-1")).toBeUndefined();
    expect(store.list()).toHaveLength(0);
    expect(store.remove("job-1")).toBe(false);
  });

  it("recordRun appends runs per job in recording order", () => {
    const store = new InMemoryCronStore();
    store.recordRun(makeRun({ jobId: "a", startedAt: 1, status: "success", output: "first" }));
    store.recordRun(makeRun({ jobId: "b", startedAt: 2, status: "error", output: "boom" }));
    store.recordRun(makeRun({ jobId: "a", startedAt: 3, status: "silent", output: "" }));

    const runsA = store.runsFor("a");
    expect(runsA.map((r) => r.startedAt)).toEqual([1, 3]);
    expect(runsA[0].status).toBe("success");
    expect(runsA[1].status).toBe("silent");

    const runsB = store.runsFor("b");
    expect(runsB.map((r) => r.startedAt)).toEqual([2]);
    expect(runsB[0].output).toBe("boom");
  });

  it("runsFor returns an empty array for a job with no runs", () => {
    const store = new InMemoryCronStore();
    store.put(makeJob());
    expect(store.runsFor("job-1")).toEqual([]);
    expect(store.runsFor("unknown")).toEqual([]);
  });

  it("recordRun does not require the job to exist", () => {
    const store = new InMemoryCronStore();
    store.recordRun(makeRun({ jobId: "ghost" }));
    expect(store.runsFor("ghost")).toHaveLength(1);
    expect(store.list()).toHaveLength(0);
  });

  it("runsFor returns a fresh array per call (defensive copy at array level)", () => {
    const store = new InMemoryCronStore();
    store.recordRun(makeRun({ jobId: "a", startedAt: 1 }));
    const first = store.runsFor("a");
    first.push(makeRun({ jobId: "a", startedAt: 99 }));
    expect(store.runsFor("a")).toHaveLength(1);
  });

  it("runsFor shares run object references (documented shallow-copy behavior)", () => {
    const store = new InMemoryCronStore();
    store.recordRun(makeRun({ jobId: "a", output: "original" }));
    const [run] = store.runsFor("a");
    run.output = "mutated";
    expect(store.runsFor("a")[0].output).toBe("mutated");
  });
});
