import { describe, expect, it } from "vitest";
import { InMemorySessionStore, ProfileSnapshotSchema } from "../index.js";
import type { ProfileSnapshot } from "../index.js";
import { CheckpointStore, checkpointStoreDepsFromSessionStore, FakeGitDiffProvider } from "./index.js";

function makeProfile(): ProfileSnapshot {
  return ProfileSnapshotSchema.parse({
    model: "gpt-4o-mini",
    provider: "openai",
    apiMode: "chat_completions",
  });
}

function makeStore() {
  const sessionStore = new InMemorySessionStore();
  const gitDiff = new FakeGitDiffProvider();
  const checkpointStore = new CheckpointStore({
    deps: checkpointStoreDepsFromSessionStore(sessionStore),
    gitDiff,
  });
  return { sessionStore, checkpointStore, gitDiff };
}

describe("CheckpointStore", () => {
  it("creates checkpoints and lists them newest first", async () => {
    const { checkpointStore, sessionStore, gitDiff } = makeStore();
    const session = await sessionStore.createSession(makeProfile());
    (gitDiff as FakeGitDiffProvider).setStatus("/workspace", [
      { path: "a.txt", added: 2, removed: 1, status: "M" },
    ]);

    const cp1 = await checkpointStore.createCheckpoint({
      sessionId: session.id,
      reason: "before edit",
      cwd: "/workspace",
      baselineMessageId: 1,
    });
    const cp2 = await checkpointStore.createCheckpoint({
      sessionId: session.id,
      reason: "before write",
      cwd: "/workspace",
      baselineMessageId: 3,
    });

    const list = await checkpointStore.listCheckpoints(session.id);
    expect(list.map((c) => c.id)).toEqual([cp2.id, cp1.id]);
    expect(list[0]?.reason).toBe("before write");
  });

  it("captures diff summaries in checkpoints", async () => {
    const { checkpointStore, sessionStore, gitDiff } = makeStore();
    const session = await sessionStore.createSession(makeProfile());
    gitDiff.setStatus("/workspace", [
      { path: "a.txt", added: 2, removed: 1, status: "M" },
      { path: "b.txt", added: 0, removed: 5, status: "D" },
    ]);

    const cp = await checkpointStore.createCheckpoint({
      sessionId: session.id,
      reason: "before edit",
      cwd: "/workspace",
    });

    expect(cp.diffSummary).toHaveLength(2);
    expect(cp.diffSummary?.find((d) => d.path === "b.txt")?.status).toBe("D");
  });

  it("returns a diff result for a checkpoint", async () => {
    const { checkpointStore, sessionStore, gitDiff } = makeStore();
    const session = await sessionStore.createSession(makeProfile());
    gitDiff.setStatus("/workspace", [{ path: "x.txt", added: 1, removed: 0, status: "A" }]);

    const cp = await checkpointStore.createCheckpoint({
      sessionId: session.id,
      reason: "before edit",
      cwd: "/workspace",
    });

    const diff = await checkpointStore.diff(session.id, cp.id);
    expect(diff.empty).toBe(false);
    expect(diff.stat).toHaveLength(1);
    expect(diff.stat[0]?.path).toBe("x.txt");
  });

  it("creates and lists snapshots", async () => {
    const { checkpointStore, sessionStore } = makeStore();
    const session = await sessionStore.createSession(makeProfile());

    const snap = await checkpointStore.createSnapshot({
      sessionId: session.id,
      label: "manual snapshot",
      cwd: "/workspace",
    });

    const list = await checkpointStore.listSnapshots(session.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toBe("manual snapshot");
    expect(list[0]?.id).toBe(snap.id);
  });

  it("rolls back messages using the rewind callback", async () => {
    const { sessionStore } = makeStore();
    const session = await sessionStore.createSession(makeProfile());
    const rewindMessages = async (_sessionId: string, baselineMessageId: number | string) => {
      expect(_sessionId).toBe(session.id);
      expect(baselineMessageId).toBe(5);
      return 2;
    };
    const store = new CheckpointStore({ deps: checkpointStoreDepsFromSessionStore(sessionStore), rewindMessages });

    const cp = await store.createCheckpoint({
      sessionId: session.id,
      reason: "before edit",
      cwd: "/workspace",
      baselineMessageId: 5,
    });

    const result = await store.rollback(session.id, cp.id);
    expect(result.deletedMessages).toBe(2);
    expect(result.checkpointId).toBe(cp.id);
  });

  it("throws when rolling back to a missing checkpoint", async () => {
    const { checkpointStore, sessionStore } = makeStore();
    const session = await sessionStore.createSession(makeProfile());
    await expect(checkpointStore.rollback(session.id, "missing")).rejects.toThrow("not found");
  });

  it("persists checkpoints in session metadata", async () => {
    const { checkpointStore, sessionStore } = makeStore();
    const session = await sessionStore.createSession(makeProfile());

    await checkpointStore.createCheckpoint({
      sessionId: session.id,
      reason: "before edit",
      cwd: "/workspace",
    });

    const fresh = new CheckpointStore({ deps: checkpointStoreDepsFromSessionStore(sessionStore) });
    const list = await fresh.listCheckpoints(session.id);
    expect(list).toHaveLength(1);
  });
});
