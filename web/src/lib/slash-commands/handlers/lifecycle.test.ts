import { describe, expect, it } from "vitest";
import { MemorySqlAdapter } from "@/lib/session-store/sql";
import { SessionStore } from "@/lib/session-store/session-store";
import type { CommandContext } from "./lifecycle";
import {
  handleBranch,
  handleClear,
  handleHistory,
  handleNew,
  handleResume,
  handleRetry,
  handleSave,
  handleSessions,
  handleTitle,
  handleUndo,
} from "./lifecycle";

function makeCtx(): { ctx: CommandContext; store: SessionStore; adapter: MemorySqlAdapter; prompts: string[] } {
  const adapter = new MemorySqlAdapter();
  const store = new SessionStore({ adapter });
  const prompts: string[] = [];
  const ctx: CommandContext = {
    store,
    activeSessionId: null,
    submitPrompt: async (_sessionId, prompt) => {
      prompts.push(prompt);
    },
    cancelTurn: async () => {},
    notify: () => {},
    cwd: "/tmp",
  };
  return { ctx, store, adapter, prompts };
}

async function addExchange(store: SessionStore, sessionId: string, user: string, assistant: string) {
  await store.appendMessages(sessionId, [
    { role: "user", content: user },
    { role: "assistant", content: assistant },
  ]);
}

describe("lifecycle slash command handlers", () => {
  it("/new creates a session", async () => {
    const { ctx } = makeCtx();
    const result = await handleNew("My Session", ctx);
    expect(result.type).not.toBe("error");
    expect(result.activeSessionId).toBeDefined();
    expect(result.output).toContain("Started new session");
  });

  it("/new without title creates an untitled session", async () => {
    const { ctx } = makeCtx();
    const result = await handleNew("", ctx);
    expect(result.type).not.toBe("error");
    expect(result.activeSessionId).toBeDefined();
  });

  it("/clear starts a new session and flags view reset", async () => {
    const { ctx } = makeCtx();
    const result = await handleClear("", ctx);
    expect(result.type).not.toBe("error");
    expect(result.clearView).toBe(true);
    expect(result.activeSessionId).toBeDefined();
  });

  it("/title renames the active session", async () => {
    const { ctx, store } = makeCtx();
    const session = await store.create({ source: "test" });
    ctx.activeSessionId = session.id;
    const result = await handleTitle("New Title", ctx);
    expect(result.type).not.toBe("error");
    expect(result.output).toContain("Renamed");
    const detail = await store.get(session.id);
    expect(detail?.title).toBe("New Title");
  });

  it("/title without arg shows current title", async () => {
    const { ctx, store } = makeCtx();
    const session = await store.create({ source: "test", title: "Existing" });
    ctx.activeSessionId = session.id;
    const result = await handleTitle("", ctx);
    expect(result.type).not.toBe("error");
    expect(result.output).toContain("Existing");
  });

  it("/branch forks the active session", async () => {
    const { ctx, store } = makeCtx();
    const session = await store.create({ source: "test" });
    await store.appendMessages(session.id, [{ role: "user", content: "hello" }]);
    ctx.activeSessionId = session.id;

    const result = await handleBranch("Bugfix", ctx);
    expect(result.type).not.toBe("error");
    expect(result.activeSessionId).toBeDefined();
    expect(result.activeSessionId).not.toBe(session.id);
    const branch = await store.get(result.activeSessionId!);
    expect(branch?.parent_session_id).toBe(session.id);
  });

  it("/history returns transcript summary", async () => {
    const { ctx, store } = makeCtx();
    const session = await store.create({ source: "test", title: "History Test" });
    await addExchange(store, session.id, "hi", "hello");
    ctx.activeSessionId = session.id;

    const result = await handleHistory("", ctx);
    expect(result.type).not.toBe("error");
    expect(result.output).toContain("History for History Test");
    expect(result.export?.format).toBe("text");
  });

  it("/save exports as Markdown", async () => {
    const { ctx, store } = makeCtx();
    const session = await store.create({ source: "test", title: "Save Test" });
    await addExchange(store, session.id, "hi", "hello");
    ctx.activeSessionId = session.id;

    const result = await handleSave("", ctx);
    expect(result.type).not.toBe("error");
    expect(result.export?.format).toBe("md");
    expect(result.export?.content).toContain("# Save Test");
    expect(result.export?.content).toContain("User");
  });

  it("/sessions lists sessions", async () => {
    const { ctx, store } = makeCtx();
    await store.create({ source: "test", title: "One" });
    await store.create({ source: "test", title: "Two" });
    const result = await handleSessions("", ctx);
    expect(result.type).not.toBe("error");
    expect(result.output).toContain("One");
    expect(result.output).toContain("Two");
  });

  it("/sessions <target> delegates to resume", async () => {
    const { ctx, store } = makeCtx();
    const session = await store.create({ source: "test", title: "Target" });
    const result = await handleSessions(session.id, ctx);
    expect(result.type).not.toBe("error");
    expect(result.activeSessionId).toBe(session.id);
  });

  it("/resume switches to a session", async () => {
    const { ctx, store } = makeCtx();
    const session = await store.create({ source: "test", title: "Resume Me" });
    const result = await handleResume(session.id, ctx);
    expect(result.type).not.toBe("error");
    expect(result.activeSessionId).toBe(session.id);
  });

  it("/resume follows compression tip", async () => {
    const { ctx, store, adapter } = makeCtx();
    const root = await store.create({ source: "test" });
    const empty = await store.create({ parentSessionId: root.id, source: "compression", now: 1000 });
    await adapter.exec("UPDATE sessions SET end_reason = ? WHERE id = ?", ["compressed", empty.id]);
    const tip = await store.create({ parentSessionId: root.id, source: "compression", now: 1001 });
    await adapter.exec("UPDATE sessions SET end_reason = ? WHERE id = ?", ["compressed", tip.id]);
    await store.appendMessages(tip.id, [{ role: "user", content: "tip" }]);

    const result = await handleResume(root.id, ctx);
    expect(result.type).not.toBe("error");
    expect(result.activeSessionId).toBe(tip.id);
  });

  it("/retry rewinds to last user message and returns pending prompt", async () => {
    const { ctx, store, prompts } = makeCtx();
    const session = await store.create({ source: "test" });
    await addExchange(store, session.id, "first", "ok");
    await addExchange(store, session.id, "second", "done");
    ctx.activeSessionId = session.id;

    const result = await handleRetry("", ctx);
    expect(result.type).not.toBe("error");
    expect(result.pendingPrompt).toBe("second");
    const remaining = await store.getMessages(session.id);
    expect(remaining).toHaveLength(2);
  });

  it("/undo removes the last exchange", async () => {
    const { ctx, store } = makeCtx();
    const session = await store.create({ source: "test" });
    await addExchange(store, session.id, "first", "ok");
    await addExchange(store, session.id, "second", "done");
    ctx.activeSessionId = session.id;

    const result = await handleUndo("", ctx);
    expect(result.type).not.toBe("error");
    expect(result.output).toContain("Undid");
    const remaining = await store.getMessages(session.id);
    expect(remaining).toHaveLength(2);
    expect(remaining[remaining.length - 1].content).toBe("ok");
  });

  it("/undo N removes N exchanges", async () => {
    const { ctx, store } = makeCtx();
    const session = await store.create({ source: "test" });
    await addExchange(store, session.id, "a", "A");
    await addExchange(store, session.id, "b", "B");
    await addExchange(store, session.id, "c", "C");
    ctx.activeSessionId = session.id;

    const result = await handleUndo("2", ctx);
    expect(result.type).not.toBe("error");
    const remaining = await store.getMessages(session.id);
    expect(remaining).toHaveLength(2);
  });
});
