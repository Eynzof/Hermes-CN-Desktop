import { describe, expect, it } from "vitest";
import { MemorySqlAdapter } from "@/lib/session-store/sql";
import { SessionStore } from "@/lib/session-store/session-store";
import { handleCompress } from "./compress";

async function seedSession(store: SessionStore, messageCount: number) {
  const session = await store.create({ source: "test" });
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Message ${i} with enough text to count as several tokens when compressed.`,
  }));
  await store.appendMessages(
    session.id,
    messages.map((m) => ({ ...m, timestamp: Math.floor(Date.now() / 1000) })),
  );
  return session;
}

describe("handleCompress", () => {
  it("returns error without active session", async () => {
    const store = new SessionStore({ adapter: new MemorySqlAdapter() });
    const result = await handleCompress("", { activeSessionId: null, store });
    expect(result.type).toBe("error");
  });

  it("returns noop for empty session", async () => {
    const store = new SessionStore({ adapter: new MemorySqlAdapter() });
    const session = await store.create({ source: "test" });
    const result = await handleCompress("", { activeSessionId: session.id, store });
    expect(result.type).toBe("exec");
    expect(result.output).toContain("No messages to compress");
  });

  it("compresses a long session in place", async () => {
    const store = new SessionStore({ adapter: new MemorySqlAdapter() });
    const session = await seedSession(store, 40);
    const before = await store.getMessages(session.id);

    const result = await handleCompress("", {
      activeSessionId: session.id,
      store,
      contextLength: 1_000,
    });

    expect(result.type).toBe("exec");
    expect(result.output).toContain("Compressed");
    const after = await store.getMessages(session.id, { includeInactive: true });
    expect(after.length).toBeGreaterThanOrEqual(before.length - 10);
    expect(after.some((m) => (m.content ?? "").includes("CONTEXT COMPACTION"))).toBe(true);
  });

  it("supports --preview without mutating store", async () => {
    const store = new SessionStore({ adapter: new MemorySqlAdapter() });
    const session = await seedSession(store, 40);
    const before = await store.getMessages(session.id);

    const result = await handleCompress("--preview", {
      activeSessionId: session.id,
      store,
      contextLength: 1_000,
    });

    expect(result.type).toBe("exec");
    const after = await store.getMessages(session.id);
    expect(after.length).toBe(before.length);
    expect(after.every((m, i) => m.content === before[i]?.content)).toBe(true);
  });

  it("supports keep-last via here N", async () => {
    const store = new SessionStore({ adapter: new MemorySqlAdapter() });
    const session = await seedSession(store, 40);
    const result = await handleCompress("here 2", {
      activeSessionId: session.id,
      store,
      contextLength: 1_000,
    });
    expect(result.type).toBe("exec");
    expect(result.output).toContain("Compressed");
  });
});
