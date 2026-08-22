import { describe, expect, it } from "vitest";
import { InMemorySessionStore, ProfileSnapshotSchema } from "../index.js";
import type { ProfileSnapshot } from "../index.js";

function makeProfile(): ProfileSnapshot {
  return ProfileSnapshotSchema.parse({
    model: "gpt-4o-mini",
    provider: "openai",
    apiMode: "chat_completions",
  });
}

describe("InMemorySessionStore", () => {
  it("creates, retrieves, and lists sessions", async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession(makeProfile(), { title: "Test" });

    expect(session.title).toBe("Test");
    expect(session.isActive).toBe(true);

    const retrieved = await store.getSession(session.id);
    expect(retrieved?.id).toBe(session.id);

    const list = await store.listSessions();
    expect(list).toHaveLength(1);
  });

  it("archives sessions", async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession(makeProfile());

    expect(await store.archiveSession(session.id)).toBe(true);
    expect((await store.getSession(session.id))?.isActive).toBe(false);
    expect(await store.archiveSession("missing")).toBe(false);
  });

  it("appends and retrieves messages", async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession(makeProfile());

    await store.appendMessage({
      id: "m1",
      sessionId: session.id,
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });

    const messages = await store.getMessages(session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("hello");
  });
});
