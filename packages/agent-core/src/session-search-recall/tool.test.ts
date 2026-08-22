import { describe, it, expect, vi } from "vitest";
import { registry } from "@hermes/agent-tools";
import {
  createSessionSearchHandler,
  sessionSearchHandler,
  sessionSearchToolSchema,
} from "./tool.js";
import type { SessionSearchEngineLike } from "./types.js";
import type { ToolContext } from "@hermes/agent-tools";

function makeEngine(
  overrides: Partial<SessionSearchEngineLike> = {},
): SessionSearchEngineLike {
  return {
    discover: vi.fn().mockResolvedValue({ mode: "discover", results: [] }),
    scroll: vi.fn().mockResolvedValue({ mode: "scroll", results: [] }),
    readSession: vi.fn().mockResolvedValue({ mode: "read", results: [] }),
    browse: vi.fn().mockResolvedValue({ mode: "browse", results: [] }),
    ...overrides,
  };
}

function makeCtx(engine: SessionSearchEngineLike): ToolContext {
  return {
    sessionId: "test-session",
    runtime: { sessionSearchEngine: engine, profile: "default" },
  };
}

describe("sessionSearchToolSchema", () => {
  it("provides sensible defaults", () => {
    const parsed = sessionSearchToolSchema.parse({ query: "hello" });
    expect(parsed).toEqual({
      query: "hello",
      limit: 10,
      window: 5,
      sort: "rank",
    });
  });

  it("rejects limit outside [1, 100]", () => {
    expect(() => sessionSearchToolSchema.parse({ query: "x", limit: 999 })).toThrow();
    expect(() => sessionSearchToolSchema.parse({ query: "x", limit: 0 })).toThrow();
  });
});

describe("sessionSearchHandler", () => {
  it("registers the tool in the global agent-tools registry", () => {
    // Importing ./tool.js triggers side-effect registration.
    expect(registry.has("session_search")).toBe(true);
    const entry = registry.get("session_search");
    expect(entry?.toolset).toBe("session_search");
    expect(entry?.handler).toBe(sessionSearchHandler);
  });

  it("DISCOVER: calls engine.discover when only a query is provided", async () => {
    const engine = makeEngine({
      discover: vi.fn().mockResolvedValue({
        mode: "discover",
        results: [
          {
            session_id: "s1",
            snippet: "matched text",
            matched_message_id: 42,
            link: "@session:default/s1",
          },
        ],
      }),
    });

    const result = await sessionSearchHandler(
      { query: "deployment", limit: 5, window: 3 },
      makeCtx(engine),
    );

    expect(engine.discover).toHaveBeenCalledWith("deployment", {
      limit: 5,
      window: 3,
    });
    expect(engine.scroll).not.toHaveBeenCalled();
    expect(engine.readSession).not.toHaveBeenCalled();
    expect(engine.browse).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content);
    expect(parsed.mode).toBe("discover");
    expect(parsed.results[0].session_id).toBe("s1");
  });

  it("SCROLL: takes precedence over read when around_message_id is present", async () => {
    const engine = makeEngine({
      scroll: vi.fn().mockResolvedValue({
        mode: "scroll",
        results: [
          {
            session_id: "s2",
            messages: [{ id: 7, role: "user", content: "hi" }],
            context_before: [],
            context_after: [],
            link: "@session:default/s2",
          },
        ],
      }),
    });

    const result = await sessionSearchHandler(
      { session_id: "s2", around_message_id: 7, window: 2 },
      makeCtx(engine),
    );

    expect(engine.scroll).toHaveBeenCalledWith("s2", 7, 2);
    expect(engine.readSession).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content);
    expect(parsed.mode).toBe("scroll");
  });

  it("READ: calls engine.readSession when only session_id is provided", async () => {
    const engine = makeEngine({
      readSession: vi.fn().mockResolvedValue({
        mode: "read",
        results: [
          {
            session_id: "s3",
            messages: [
              { id: 1, role: "user", content: "hello" },
              { id: 2, role: "assistant", content: "world" },
            ],
            link: "@session:default/s3",
          },
        ],
      }),
    });

    const result = await sessionSearchHandler({ session_id: "s3" }, makeCtx(engine));

    expect(engine.readSession).toHaveBeenCalledWith("s3");
    expect(engine.scroll).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content);
    expect(parsed.mode).toBe("read");
    expect(parsed.results[0].messages).toHaveLength(2);
  });

  it("BROWSE: calls engine.browse when no query and no session_id", async () => {
    const engine = makeEngine({
      browse: vi.fn().mockResolvedValue({
        mode: "browse",
        results: [
          { session_id: "s4", title: "Recent", link: "@session:default/s4" },
        ],
      }),
    });

    const result = await sessionSearchHandler({ limit: 8 }, makeCtx(engine));

    expect(engine.browse).toHaveBeenCalledWith(8);
    expect(engine.discover).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.content);
    expect(parsed.mode).toBe("browse");
  });

  it("shape precedence: scroll > read > browse > discover", async () => {
    const engine = makeEngine();
    const ctx = makeCtx(engine);

    // Scroll wins over read.
    await createSessionSearchHandler()(
      { session_id: "s", around_message_id: 1 },
      ctx,
    );
    expect(engine.scroll).toHaveBeenCalled();

    // Read wins over browse/discover.
    await createSessionSearchHandler()({ session_id: "s" }, ctx);
    expect(engine.readSession).toHaveBeenCalled();

    // Browse wins over discover.
    await createSessionSearchHandler()({}, ctx);
    expect(engine.browse).toHaveBeenCalled();

    // Discover is the fallback.
    await createSessionSearchHandler()({ query: "q" }, ctx);
    expect(engine.discover).toHaveBeenCalled();
  });

  it("rejects invalid tool arguments", async () => {
    const engine = makeEngine();
    await expect(
      sessionSearchHandler({ limit: "many" }, makeCtx(engine)),
    ).rejects.toThrow();
  });

  it("errors when the engine is missing from context", async () => {
    await expect(
      sessionSearchHandler(
        { query: "x" },
        { sessionId: "s1", runtime: {} },
      ),
    ).rejects.toThrow("sessionSearchEngine is missing");
  });

  it("errors when context has no runtime", async () => {
    await expect(
      sessionSearchHandler({ query: "x" }, { sessionId: "s1" }),
    ).rejects.toThrow("runtime is missing");
  });
});
