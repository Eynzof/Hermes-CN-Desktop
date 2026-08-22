import { describe, expect, it } from "vitest";
import { MemorySqlAdapter } from "./sql";
import { MAX_TITLE_LENGTH, SessionStore } from "./session-store";
import type { CreateSessionOptions } from "./types";

function makeStore(): { store: SessionStore; adapter: MemorySqlAdapter } {
  const adapter = new MemorySqlAdapter();
  const store = new SessionStore({ adapter });
  return { store, adapter };
}

async function createSession(store: SessionStore, opts: CreateSessionOptions = {}) {
  return store.create({ source: "test", ...opts });
}

async function addMessages(store: SessionStore, sessionId: string, contents: string[]) {
  await store.appendMessages(
    sessionId,
    contents.map((content) => ({ role: "user", content })),
  );
}

async function addExchange(store: SessionStore, sessionId: string, user: string, assistant: string) {
  await store.appendMessages(sessionId, [
    { role: "user", content: user },
    { role: "assistant", content: assistant },
  ]);
}

describe("SessionStore", () => {
  it("creates a session with a stable id scheme", async () => {
    const { store } = makeStore();
    const session = await createSession(store, { title: "Hello" });
    expect(session.title).toBe("Hello");
    expect(/^\d{8}_\d{6}_[0-9a-f]{6}$/.test(session.id)).toBe(true);
    expect(session.is_active).toBe(true);
    expect(session.message_count).toBe(0);
  });

  it("retrieves a session by id", async () => {
    const { store } = makeStore();
    const created = await createSession(store, { title: "Test" });
    const detail = await store.get(created.id);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(created.id);
    expect(detail?.last_active).toBe(detail?.started_at);
  });

  it("lists sessions ordered by recency", async () => {
    const { store } = makeStore();
    const first = await createSession(store, { title: "First" });
    const second = await createSession(store, { title: "Second" });
    const list = await store.list({ limit: 10, offset: 0 });
    expect(list.sessions).toHaveLength(2);
    expect(list.sessions[0].id).toBe(second.id);
    expect(list.sessions[1].id).toBe(first.id);
  });

  it("supports pagination", async () => {
    const { store } = makeStore();
    for (let i = 0; i < 5; i++) {
      await createSession(store, { title: `Session ${i}` });
    }
    const page = await store.list({ limit: 2, offset: 1 });
    expect(page.sessions).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it("resolves exact session id", async () => {
    const { store } = makeStore();
    const created = await createSession(store);
    const resolved = await store.resolveSessionId(created.id);
    expect(resolved).toBe(created.id);
  });

  it("resolves unique prefix", async () => {
    const { store } = makeStore();
    const created = await createSession(store);
    const resolved = await store.resolveSessionId(created.id.slice(0, 10));
    expect(resolved).toBe(created.id);
  });

  it("returns undefined for ambiguous prefix", async () => {
    const { store } = makeStore();
    await createSession(store);
    await createSession(store);
    const resolved = await store.resolveSessionId("20");
    expect(resolved).toBeUndefined();
  });

  describe("title provenance", () => {
    it("sets a user title and rejects empty/too-long", async () => {
      const { store } = makeStore();
      const session = await createSession(store);
      await store.setTitle(session.id, "User Title");
      const detail = await store.get(session.id);
      expect(detail?.title).toBe("User Title");

      await expect(store.setTitle(session.id, "")).rejects.toThrow("empty");
      await expect(store.setTitle(session.id, "x".repeat(MAX_TITLE_LENGTH + 1))).rejects.toThrow(
        `${MAX_TITLE_LENGTH}`,
      );
    });

    it("sanitizes control characters", async () => {
      const { store } = makeStore();
      const session = await createSession(store);
      await store.setTitle(session.id, "Hello\n\x00World");
      const detail = await store.get(session.id);
      expect(detail?.title).toBe("Hello World");
    });

    it("enforces title provenance ranks", async () => {
      const { store } = makeStore();
      const session = await createSession(store);
      expect(await store.setAutoTitle(session.id, "Derived", "derived")).toBe(true);
      expect((await store.get(session.id))?.title).toBe("Derived");

      // Derived cannot overwrite user.
      await store.setTitle(session.id, "User");
      expect((await store.get(session.id))?.title).toBe("User");
      expect(await store.setAutoTitle(session.id, "Derived 2", "derived")).toBe(false);
      expect((await store.get(session.id))?.title).toBe("User");

      // LLM can overwrite derived but not user.
      const session2 = await createSession(store);
      await store.setAutoTitle(session2.id, "Derived", "derived");
      expect(await store.setAutoTitle(session2.id, "LLM", "llm")).toBe(true);
      expect((await store.get(session2.id))?.title).toBe("LLM");
      expect(await store.setAutoTitle(session2.id, "Derived 2", "derived")).toBe(false);
    });
  });

  describe("messages and rewind", () => {
    it("appends and retrieves messages", async () => {
      const { store } = makeStore();
      const session = await createSession(store);
      await addMessages(store, session.id, ["hi", "there"]);
      const messages = await store.getMessages(session.id);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("hi");
      expect(messages[1].content).toBe("there");
      expect(messages[0].role).toBe("user");
    });

    it("rewinds to a target user message", async () => {
      const { store } = makeStore();
      const session = await createSession(store);
      await addExchange(store, session.id, "A", "B");
      await addExchange(store, session.id, "C", "D");
      const messages = await store.getMessages(session.id);
      const targetId = messages[2].id as number;

      const result = await store.rewindToMessage(session.id, targetId);
      expect(result.targetMessage?.content).toBe("C");
      expect(result.rewindCount).toBe(1);

      const remaining = await store.getMessages(session.id);
      expect(remaining).toHaveLength(2);
      expect(remaining[0].content).toBe("A");
      expect(remaining[1].content).toBe("B");
    });

    it("restores rewound messages", async () => {
      const { store } = makeStore();
      const session = await createSession(store);
      await addExchange(store, session.id, "A", "B");
      await addExchange(store, session.id, "C", "D");
      const messages = await store.getMessages(session.id);
      const targetId = messages[2].id as number;

      await store.rewindToMessage(session.id, targetId);
      const restored = await store.restoreRewound(session.id, targetId);
      expect(restored).toBe(2);
      const messagesAfter = await store.getMessages(session.id);
      expect(messagesAfter).toHaveLength(4);
    });

    it("clears all messages", async () => {
      const { store } = makeStore();
      const session = await createSession(store);
      await addMessages(store, session.id, ["hi"]);
      await store.clearMessages(session.id);
      expect(await store.getMessages(session.id)).toHaveLength(0);
    });
  });

  describe("fork/branch", () => {
    it("forks a session with copied messages", async () => {
      const { store } = makeStore();
      const parent = await createSession(store, { title: "Parent" });
      await addExchange(store, parent.id, "A", "B");
      await addExchange(store, parent.id, "C", "D");

      const branch = await store.fork(parent.id, { title: "Branch" });
      expect(branch.parent_session_id).toBe(parent.id);
      expect(branch.title).toBe("Branch");

      const branchMessages = await store.getMessages(branch.id);
      expect(branchMessages).toHaveLength(4);
      expect(branchMessages[2].content).toBe("C");

      const parentDetail = await store.get(parent.id);
      expect(parentDetail?.end_reason).toBe("branched");
      expect(parentDetail?.ended_at).not.toBeNull();
    });

    it("truncates fork at upToMessageId", async () => {
      const { store } = makeStore();
      const parent = await createSession(store);
      await addExchange(store, parent.id, "A", "B");
      await addExchange(store, parent.id, "C", "D");
      const messages = await store.getMessages(parent.id);
      const upTo = messages[1].id as number;

      const branch = await store.fork(parent.id, { upToMessageId: upTo });
      const branchMessages = await store.getMessages(branch.id);
      expect(branchMessages).toHaveLength(2);
    });
  });

  describe("archive and delete", () => {
  it("archives and unarchives a session", async () => {
    const { store } = makeStore();
    const session = await createSession(store);
    expect(await store.archive(session.id, true)).toBe(true);
    const listActive = await store.list({ limit: 10, offset: 0 });
    expect(listActive.sessions).toHaveLength(0);
    const listArchived = await store.list({ limit: 10, offset: 0, includeArchived: true });
    expect(listArchived.sessions).toHaveLength(1);

    expect(await store.archive(session.id, false)).toBe(true);
    expect((await store.list({ limit: 10, offset: 0 })).sessions).toHaveLength(1);
  });

    it("deletes a session and its messages", async () => {
      const { store } = makeStore();
      const session = await createSession(store);
      await addMessages(store, session.id, ["hi"]);
      await store.delete(session.id);
      expect(await store.get(session.id)).toBeNull();
    });
  });

  describe("compression-tip resume", () => {
    it("returns the original session when it has messages", async () => {
      const { store } = makeStore();
      const session = await createSession(store);
      await addMessages(store, session.id, ["hi"]);
      const resolved = await store.resolveResumeSessionId(session.id);
      expect(resolved).toBe(session.id);
    });

    it("follows compression children to find the message-bearing tip", async () => {
      const { store, adapter } = makeStore();
      const root = await createSession(store);
      // Simulate compression chain: empty compression child, then message-bearing tip.
      const empty = await store.create({ parentSessionId: root.id, source: "compression", now: 1000 });
      await adapter.exec("UPDATE sessions SET end_reason = ? WHERE id = ?", ["compressed", empty.id]);
      const child = await store.create({ parentSessionId: root.id, source: "compression", now: 1001 });
      await adapter.exec("UPDATE sessions SET end_reason = ? WHERE id = ?", ["compressed", child.id]);
      await addMessages(store, child.id, ["compressed tip"]);

      const resolved = await store.resolveResumeSessionId(root.id);
      expect(resolved).toBe(child.id);
    });

    it("skips branch children when resolving resume tip", async () => {
      const { store } = makeStore();
      const root = await createSession(store);
      const branch = await store.fork(root.id, { title: "Branch" });
      const resolved = await store.resolveResumeSessionId(root.id);
      // Branch has messages but is a branch child, so root should remain unresolved.
      expect(resolved).toBe(root.id);
    });
  });

  describe("search", () => {
    it("finds messages by content", async () => {
      const { store } = makeStore();
      const session = await createSession(store);
      await addMessages(store, session.id, ["hello world", "goodbye"]);
      const results = await store.search("hello");
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("hello world");
      expect(results[0].session_id).toBe(session.id);
    });
  });
});
