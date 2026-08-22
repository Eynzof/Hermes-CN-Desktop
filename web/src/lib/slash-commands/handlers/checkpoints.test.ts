import { describe, expect, it } from "vitest";
import { MemorySqlAdapter } from "@/lib/session-store/sql";
import { SessionStore } from "@/lib/session-store/session-store";
import {
  FakeGitDiffProvider,
  type GitDiffProvider,
} from "@hermes/agent-core";
import { handleRollback, handleSnapshot, handleDiff, createWebCheckpointStore } from "./checkpoints";

function makeContext() {
  const adapter = new MemorySqlAdapter();
  const store = new SessionStore({ adapter });
  const gitDiff: GitDiffProvider = new FakeGitDiffProvider();
  const checkpointStore = createWebCheckpointStore(store, {
    gitDiff,
    rewindMessages: async () => 0,
  });
  return { store, checkpointStore, gitDiff };
}

async function seedSession(store: SessionStore) {
  return store.create({ source: "test", title: "Checkpoint test", cwd: "/workspace" });
}

describe("checkpoint slash handlers", () => {
  it("/rollback lists checkpoints when no id is given", async () => {
    const { store, checkpointStore } = makeContext();
    const session = await seedSession(store);
    await checkpointStore.createCheckpoint({
      sessionId: session.id,
      reason: "before edit",
      cwd: "/workspace",
    });

    const result = await handleRollback("", {
      activeSessionId: session.id,
      store,
      checkpointStore,
    });

    expect(result.type).toBe("exec");
    expect(result.output).toContain("Checkpoints:");
    expect(result.output).toContain("before edit");
  });

  it("/rollback rolls back to a checkpoint id", async () => {
    const { store, checkpointStore } = makeContext();
    const session = await seedSession(store);
    const cp = await checkpointStore.createCheckpoint({
      sessionId: session.id,
      reason: "before edit",
      cwd: "/workspace",
      baselineMessageId: 1,
    });

    const result = await handleRollback(cp.id, {
      activeSessionId: session.id,
      store,
      checkpointStore,
      notify: (msg) => {
        expect(msg).toContain("Rolled back");
      },
    });

    expect(result.type).toBe("exec");
    expect(result.output).toContain("Rolled back");
  });

  it("/snapshot creates a snapshot", async () => {
    const { store, checkpointStore } = makeContext();
    const session = await seedSession(store);

    const result = await handleSnapshot("manual save", {
      activeSessionId: session.id,
      store,
      checkpointStore,
    });

    expect(result.type).toBe("exec");
    expect(result.output).toContain("Created snapshot");
    const snapshots = await checkpointStore.listSnapshots(session.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.label).toBe("manual save");
  });

  it("/diff shows current session diff", async () => {
    const { store, checkpointStore, gitDiff } = makeContext();
    const fake = gitDiff as FakeGitDiffProvider;
    fake.setStatus("/workspace", [{ path: "a.txt", added: 2, removed: 1, status: "M" }]);
    const session = await seedSession(store);

    const result = await handleDiff("", {
      activeSessionId: session.id,
      store,
      checkpointStore,
    });

    expect(result.type).toBe("exec");
    expect(result.output).toContain("Session diff");
    expect(result.output).toContain("a.txt");
  });

  it("/diff shows checkpoint diff by id", async () => {
    const { store, checkpointStore } = makeContext();
    const session = await seedSession(store);
    const cp = await checkpointStore.createCheckpoint({
      sessionId: session.id,
      reason: "before edit",
      cwd: "/workspace",
    });

    const result = await handleDiff(cp.id, {
      activeSessionId: session.id,
      store,
      checkpointStore,
    });

    expect(result.type).toBe("exec");
    expect(result.output).toContain(`Diff for checkpoint ${cp.id}`);
  });

  it("returns error without active session", async () => {
    const { store, checkpointStore } = makeContext();
    const result = await handleRollback("", {
      activeSessionId: null,
      store,
      checkpointStore,
    });
    expect(result.type).toBe("error");
    expect(result.message).toContain("No active session");
  });
});
