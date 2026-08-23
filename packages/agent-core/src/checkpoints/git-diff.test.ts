import { describe, expect, it } from "vitest";
import { FakeGitDiffProvider, NoopGitDiffProvider, type GitDiffProvider } from "./git-diff.js";
import type { DiffRecord, DiffResult } from "./types.js";

const EMPTY_RESULT: DiffResult = { empty: true, stat: [], diff: "" };

const record: DiffRecord = { path: "src/a.ts", added: 2, removed: 1, status: "M" };

describe("NoopGitDiffProvider", () => {
  it("returns an empty status for any cwd", async () => {
    const provider = new NoopGitDiffProvider();
    await expect(provider.status()).resolves.toEqual([]);
    await expect(provider.status()).resolves.toEqual([]);
  });

  it("returns an empty diff for any args", async () => {
    const provider = new NoopGitDiffProvider();
    await expect(provider.diff()).resolves.toEqual(EMPTY_RESULT);
    await expect(provider.diff()).resolves.toEqual(EMPTY_RESULT);
  });

  it("does not implement the optional restore hook", () => {
    expect((new NoopGitDiffProvider() as GitDiffProvider).restore).toBeUndefined();
  });
});

describe("FakeGitDiffProvider", () => {
  it("starts empty for every cwd", async () => {
    const provider = new FakeGitDiffProvider();
    await expect(provider.status("cwd")).resolves.toEqual([]);
  });

  it("returns status records previously set for a cwd", async () => {
    const provider = new FakeGitDiffProvider();
    provider.setStatus("cwd", [record]);
    await expect(provider.status("cwd")).resolves.toEqual([record]);
  });

  it("keeps statuses isolated per cwd", async () => {
    const provider = new FakeGitDiffProvider();
    provider.setStatus("a", [record]);
    await expect(provider.status("a")).resolves.toEqual([record]);
    await expect(provider.status("b")).resolves.toEqual([]);
  });

  it("overwrites the status for a cwd", async () => {
    const provider = new FakeGitDiffProvider();
    provider.setStatus("cwd", [record]);
    provider.setStatus("cwd", []);
    await expect(provider.status("cwd")).resolves.toEqual([]);
  });

  it("returns the default empty diff for unknown keys", async () => {
    const provider = new FakeGitDiffProvider();
    await expect(provider.diff("cwd")).resolves.toEqual(EMPTY_RESULT);
    await expect(provider.diff("cwd", { ref: "HEAD" })).resolves.toEqual(EMPTY_RESULT);
    await expect(provider.diff("cwd", { ref: "HEAD", statOnly: true })).resolves.toEqual(EMPTY_RESULT);
  });

  it("returns the diff set for the worktree key (no opts)", async () => {
    const provider = new FakeGitDiffProvider();
    const result: DiffResult = { empty: false, stat: [record], diff: "--- a/src/a.ts\n+++ b/src/a.ts\n" };
    provider.setDiff("cwd", "worktree:false", result);
    await expect(provider.diff("cwd")).resolves.toBe(result);
  });

  it("keys diffs by ref and statOnly", async () => {
    const provider = new FakeGitDiffProvider();
    const worktree: DiffResult = { empty: false, stat: [record], diff: "worktree diff" };
    const head: DiffResult = { empty: false, stat: [record], diff: "head diff" };
    const headStat: DiffResult = { empty: false, stat: [record], diff: "" };

    provider.setDiff("cwd", "worktree:false", worktree);
    provider.setDiff("cwd", "HEAD:false", head);
    provider.setDiff("cwd", "HEAD:true", headStat);

    await expect(provider.diff("cwd")).resolves.toBe(worktree);
    await expect(provider.diff("cwd", { ref: "HEAD" })).resolves.toBe(head);
    await expect(provider.diff("cwd", { ref: "HEAD", statOnly: true })).resolves.toBe(headStat);
    // A different key must not leak into another cwd's lookup.
    await expect(provider.diff("other", { ref: "HEAD", statOnly: true })).resolves.toEqual(EMPTY_RESULT);
  });

  it("does not implement the optional restore hook", () => {
    expect((new FakeGitDiffProvider() as GitDiffProvider).restore).toBeUndefined();
  });
});
